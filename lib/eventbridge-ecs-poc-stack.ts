import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export class EventbridgeEcsPocStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPCの作成
    const vpc = new ec2.Vpc(this, 'EventbridgeEcsPocVpc', {
      maxAzs: 2,
    });

    // ECSクラスターの作成
    const cluster = new ecs.Cluster(this, 'EventbridgeEcsPocCluster', {
      vpc: vpc,
    });

    // SQSキューの作成
    const queue = new sqs.Queue(this, 'EventbridgeEcsPocQueue');

    // ECSタスク定義の作成
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      'EventbridgeEcsPocTaskDef'
    );

    const container = taskDefinition.addContainer(
      'EventbridgeEcsPocContainer',
      {
        image: ecs.ContainerImage.fromRegistry(
          'public.ecr.aws/docker/library/hello-world:nanoserver'
        ),
        memoryLimitMiB: 512,
        cpu: 256,
        // environment: {
        //   SQS_QUEUE_URL: queue.queueUrl,
        // },
      }
    );

    // SQSキューへのアクセス権をコンテナに付与
    queue.grantConsumeMessages(taskDefinition.taskRole);

    // EventBridgeルールの作成
    const rule = new events.Rule(this, 'EventbridgeEcsPocRule', {
      eventPattern: {
        source: ['aws.sqs'],
        detail: {
          eventSource: ['sqs.amazonaws.com'],
          eventName: ['SendMessage'],
        },
      },
    });

    // EventBridgeターゲットの作成
    rule.addTarget(
      new targets.EcsTask({
        cluster: cluster,
        taskDefinition: taskDefinition,
        taskCount: 1,
        subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [
          ec2.SecurityGroup.fromSecurityGroupId(
            this,
            'SG',
            vpc.vpcDefaultSecurityGroup
          ),
        ],
        taskRole: taskDefinition.taskRole,
        // containerOverrides: [
        //   {
        //     containerName: 'EventbridgeEcsPocContainer',
        //     environment: [
        //       {
        //         name: 'RECEIPT_HANDLE',
        //         value: events.RuleTargetInput.fromEventPath(
        //           '$.detail.requestParameters.receiptHandle'
        //         ),
        //       },
        //       {
        //         name: 'MESSAGE_BODY',
        //         value: events.RuleTargetInput.fromEventPath(
        //           '$.detail.requestParameters.messageBody'
        //         ),
        //       },
        //     ],
        //   },
        // ],
      })
    );
  }
}
