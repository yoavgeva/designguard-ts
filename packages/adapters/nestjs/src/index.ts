import { defineAdapter, type ParameterSpec } from "@designguard/core";

// What a handler's parameters hold, by their decorators: what the request sends, the user asking, as a project's
// `@CurrentUser()` or `@Auth()` gives them, or a request or context holding them.
const parameters: ParameterSpec[] = [
  { decorator: "{Body,Param,Query,Args,UploadedFile,UploadedFiles}", holds: "input" },
  { decorator: "*{User,Session,Auth,Principal,Actor,Viewer,Account,Member,Identity}*", holds: "user" },
  { decorator: "{Req,Request,Context,Ctx}", holds: "context" },
];

/**
 * NestJS 9 to 12: controller methods with a route decorator, and GraphQL resolvers' queries and mutations. Guards,
 * and decorators that record who may call a handler, as `SetMetadata` does for a guard to read, check permissions,
 * on the method or its class.
 */
export default defineAdapter({
  name: "nestjs",
  packages: ["@nestjs/common", "@nestjs/graphql"],
  versions: ">=9 <13",
  entryPoints: [
    { decorator: "{Get,Head,Options}", reads: true, parameters },
    { decorator: "{Post,Put,Patch,Delete,All}", parameters },
    { decorator: "Query", reads: true, parameters },
    { decorator: "Mutation", parameters },
  ],
  checks: ["{UseGuards,SetMetadata}"],
});
