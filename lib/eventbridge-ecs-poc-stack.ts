import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export class EventbridgeEcsPocStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Dead Letter Queue の作成
    const deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      retentionPeriod: cdk.Duration.days(14), // 必要に応じて保持期間を調整
    });

    // 1. SQS キューの作成
    const queue = new sqs.Queue(this, 'ProcessingQueue', {
      visibilityTimeout: cdk.Duration.seconds(90),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3, // 受信回数が3回を超えると DLQ にメッセージが移動
      },
    });

    // 2. VPC と ECS クラスターの作成
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2 });
    const cluster = new ecs.Cluster(this, 'EcsCluster', { vpc });

    // 3. Docker イメージのビルドと ECR 登録
    // app ディレクトリに Dockerfile, index.js などがある前提
    const imageAsset = new ecr_assets.DockerImageAsset(
      this,
      'FileProcessorImage',
      {
        directory: path.join(__dirname, '../app'),
      }
    );

    // 4. 2 種類の Fargate タスク定義の作成（どちらも最小リソース: cpu=256, memory=512）
    // タスク定義 A（TASK_TYPE='A'）
    const taskDefinitionA = new ecs.FargateTaskDefinition(this, 'TaskDefA', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    const containerA = taskDefinitionA.addContainer('FileProcessorContainerA', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'FileProcessing-A' }),
    });

    // タスク定義 B（TASK_TYPE='B'）
    const taskDefinitionB = new ecs.FargateTaskDefinition(this, 'TaskDefB', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    const containerB = taskDefinitionB.addContainer('FileProcessorContainerB', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'FileProcessing-B' }),
    });

    // 5. Step Functions タスクの作成
    // ECS Run Task for TASK_TYPE 'A'
    const runTaskA = new tasks.EcsRunTask(this, 'RunTaskA', {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster,
      taskDefinition: taskDefinitionA,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      containerOverrides: [
        {
          containerDefinition: containerA,
          environment: [
            {
              name: 'S3_FILE_PATH',
              value: sfn.JsonPath.stringAt('$.s3FilePath'),
            },
            { name: 'TASK_TYPE', value: 'A' },
          ],
        },
      ],
      taskTimeout: sfn.Timeout.duration(cdk.Duration.minutes(30)),
    });
    runTaskA.addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(5) });

    // ECS Run Task for TASK_TYPE 'B'
    const runTaskB = new tasks.EcsRunTask(this, 'RunTaskB', {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster,
      taskDefinition: taskDefinitionB,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      containerOverrides: [
        {
          containerDefinition: containerB,
          environment: [
            {
              name: 'S3_FILE_PATH',
              value: sfn.JsonPath.stringAt('$.s3FilePath'),
            },
            { name: 'TASK_TYPE', value: 'B' },
          ],
        },
      ],
      taskTimeout: sfn.Timeout.duration(cdk.Duration.minutes(30)),
    });
    runTaskB.addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(5) });

    // Choice ステートで ECS タスクを分岐（入力の taskType による選択）
    const choice = new sfn.Choice(this, 'ChooseTaskDefinition');
    choice.when(sfn.Condition.stringEquals('$.taskType', 'A'), runTaskA);
    choice.when(sfn.Condition.stringEquals('$.taskType', 'B'), runTaskB);
    // デフォルトは TASK_TYPE "A" とする
    choice.otherwise(runTaskA);

    // 6. State Machine の作成（definitionBody を使用）
    const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(choice),
      timeout: cdk.Duration.minutes(60),
    });

    // 7. EventBridge Pipes 用の IAM ロールを作成
    const pipeRole = new iam.Role(this, 'PipeRole', {
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });
    // SQS からの読み出し権限
    pipeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
        ],
        resources: [queue.queueArn],
      })
    );
    // Step Functions の起動権限
    pipeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution', 'states:StartSyncExecution'],
        resources: [stateMachine.stateMachineArn],
      })
    );

    const pipeLogGroup = new logs.LogGroup(this, 'PipeLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // 8. EventBridge Pipes の作成
    // inputTemplate で、SQS の本文と Message Attributes から必要情報を抽出して、State Machine の入力に渡す
    new pipes.CfnPipe(this, 'SqsToStateMachinePipe', {
      roleArn: pipeRole.roleArn,
      source: queue.queueArn,
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 1,
        },
      },
      target: stateMachine.stateMachineArn,
      targetParameters: {
        stepFunctionStateMachineParameters: {
          invocationType: 'FIRE_AND_FORGET',
        },
        inputTemplate: JSON.stringify({
          s3FilePath: '<$.body.s3FilePath>',
          taskType: '<$.messageAttributes.taskType.stringValue>',
        }),
      },
      logConfiguration: {
        cloudwatchLogsLogDestination: {
          logGroupArn: pipeLogGroup.logGroupArn,
        },
        level: 'ERROR',
      },
    });
  }
}
