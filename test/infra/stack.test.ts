import { describe, it, expect, beforeAll } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { HomeOpsStack } from "../../infra/stack.js";

describe("HomeOps Stack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new HomeOpsStack(app, "TestStack", {
      env: { region: "eu-north-1", account: "123456789" },
    });
    template = Template.fromStack(stack);
  });

  it("synthesizes without errors", () => {
    // If beforeAll succeeds, synthesis worked. Verify template is not empty.
    const resources = template.toJSON().Resources;
    expect(Object.keys(resources).length).toBeGreaterThan(0);
  });

  describe("DynamoDB tables", () => {
    it("contains exactly 2 DynamoDB tables", () => {
      template.resourceCountIs("AWS::DynamoDB::Table", 2);
    });
  });

  describe("SQS queues", () => {
    it("contains at least 2 SQS queues", () => {
      const queues = template.findResources("AWS::SQS::Queue");
      expect(Object.keys(queues).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Lambda functions", () => {
    it("contains exactly 3 Lambda functions", () => {
      template.resourceCountIs("AWS::Lambda::Function", 3);
    });
  });

  describe("HTTP API", () => {
    it("contains exactly 1 HTTP API", () => {
      template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    });
  });

  describe("CloudWatch alarms", () => {
    it("contains exactly 2 CloudWatch alarms", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    });
  });

  describe("Secrets Manager secrets", () => {
    it("contains at least 3 Secrets Manager secrets", () => {
      const secrets = template.findResources("AWS::SecretsManager::Secret");
      expect(Object.keys(secrets).length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Lambda log groups", () => {
    it("all log groups have 30-day retention", () => {
      const logGroups = template.findResources("AWS::Logs::LogGroup");
      const logGroupKeys = Object.keys(logGroups);

      expect(logGroupKeys.length).toBeGreaterThanOrEqual(3);

      for (const key of logGroupKeys) {
        expect(logGroups[key].Properties.RetentionInDays).toBe(30);
      }
    });
  });
});
