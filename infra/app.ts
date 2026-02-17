import * as cdk from "aws-cdk-lib";
import { HomeOpsStack } from "./stack.js";
import { config } from "./config.js";

const app = new cdk.App();
new HomeOpsStack(app, config.stackName, {
  env: { region: config.region },
});
