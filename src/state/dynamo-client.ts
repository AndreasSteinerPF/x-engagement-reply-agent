import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export function createDynamoDocumentClient(
  client: DynamoDBClient = new DynamoDBClient({}),
): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}
