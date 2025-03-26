const AWS = require('aws-sdk');
const stepfunctions = new AWS.StepFunctions();

exports.handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));
  for (const record of event.Records) {
    const body = JSON.parse(record.body);
    // taskTypeをSQSのMessage Attributesから取得
    const taskType = record.messageAttributes && record.messageAttributes.taskType
      ? record.messageAttributes.taskType.stringValue
      : "A"; // デフォルト値
    const input = { ...body, taskType };
    const params = {
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      input: JSON.stringify(input)
    };
    await stepfunctions.startExecution(params).promise();
  }
  return {};
};
