import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';

export class EventbridgeEcsPocStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. SQS キューの作成
    const queue = new sqs.Queue(this, 'ProcessingQueue', {
      visibilityTimeout: cdk.Duration.seconds(90),
    });

    // 2. VPC と ECS クラスターの作成
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2 });
    const cluster = new ecs.Cluster(this, 'EcsCluster', { vpc });

    // 3. Docker イメージのビルドと ECR 登録（app ディレクトリに Dockerfile, index.js がある前提）
    const imageAsset = new ecr_assets.DockerImageAsset(this, 'FileProcessorImage', {
      directory: path.join(__dirname, '../app'),
    });

    // 4. 2 種類の Fargate タスク定義 (最小リソース: cpu 256, memory 512) の作成
    // タスク定義 A (TASK_TYPE = "A")
    const taskDefinitionA = new ecs.FargateTaskDefinition(this, 'TaskDefA', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    const containerA = taskDefinitionA.addContainer('FileProcessorContainerA', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'FileProcessing-A' }),
    });

    // タスク定義 B (TASK_TYPE = "B")
    const taskDefinitionB = new ecs.FargateTaskDefinition(this, 'TaskDefB', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    const containerB = taskDefinitionB.addContainer('FileProcessorContainerB', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'FileProcessing-B' }),
    });

    // 5. Step Functions タスクの作成
    const runTaskA = new tasks.EcsRunTask(this, 'RunTaskA', {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster,
      taskDefinition: taskDefinitionA,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      containerOverrides: [{
        containerDefinition: containerA,
        environment: [
          {
            name: 'S3_FILE_PATH',
            value: sfn.JsonPath.stringAt('$.s3FilePath'),
          },
          {
            name: 'TASK_TYPE',
            value: 'A',
          },
        ],
      }],
      timeout: cdk.Duration.minutes(30),
    });
    runTaskA.addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(5) });

    const runTaskB = new tasks.EcsRunTask(this, 'RunTaskB', {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster,
      taskDefinition: taskDefinitionB,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      containerOverrides: [{
        containerDefinition: containerB,
        environment: [
          {
            name: 'S3_FILE_PATH',
            value: sfn.JsonPath.stringAt('$.s3FilePath'),
          },
          {
            name: 'TASK_TYPE',
            value: 'B',
          },
        ],
      }],
      timeout: cdk.Duration.minutes(30),
    });
    runTaskB.addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(5) });

    // Choice ステート：SQS のメタデータ中の taskType に応じて分岐
    const choice = new sfn.Choice(this, 'ChooseTaskDefinition');
    choice.when(sfn.Condition.stringEquals('$.taskType', 'A'), runTaskA);
    choice.when(sfn.Condition.stringEquals('$.taskType', 'B'), runTaskB);
    choice.otherwise(runTaskA);

    const stateMachineDefinition = choice;
    const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definition: stateMachineDefinition,
      timeout: cdk.Duration.minutes(60),
    });

    // 6. Lambda 関数の作成
    // この Lambda 関数は SQS イベントソースにより起動され、SQS メッセージの Message Attributes から taskType を取得し、
    // Step Functions の StartExecution を呼び出します。
    const startExecutionFunction = new lambda.Function(this, 'StartExecutionFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const stepfunctions = new AWS.StepFunctions();
        exports.handler = async (event) => {
          console.log("Received event:", JSON.stringify(event, null, 2));
          for (const record of event.Records) {
            const body = JSON.parse(record.body);
            // taskType を SQS の Message Attributes から取得
            const taskType = record.messageAttributes && record.messageAttributes.taskType
              ? record.messageAttributes.taskType.stringValue
              : "A"; // デフォルト値
            // 入力に taskType を付加
            const input = { ...body, taskType };
            const params = {
              stateMachineArn: process.env.STATE_MACHINE_ARN,
              input: JSON.stringify(input)
            };
            await stepfunctions.startExecution(params).promise();
          }
          return {};
        };
      `),
      environment: {
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
    });
    stateMachine.grantStartExecution(startExecutionFunction);

    // 7. Lambda 関数に SQS イベントソースを追加
    startExecutionFunction.addEventSource(new lambdaEventSources.SqsEventSource(queue, {
      batchSize: 1,
      enabled: true,
    }));
  }
}
