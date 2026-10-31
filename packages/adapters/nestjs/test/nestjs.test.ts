import { defineAdapter, entryPointsOf, findingsOf, stubPackage } from "@designguard/adapter-kit";
import { describe, expect, it } from "vitest";
import nestjs from "../src/index.js";

// The shape of @nestjs/common's and @nestjs/graphql's decorators: route decorators are constants of a function type.
const files = {
  ...stubPackage(
    "@nestjs/common",
    "11.1.6",
    `export declare function Controller(prefix?: string): ClassDecorator;
     export declare function Injectable(): ClassDecorator;
     export declare const Get: (path?: string) => MethodDecorator;
     export declare const Post: (path?: string) => MethodDecorator;
     export declare const Delete: (path?: string) => MethodDecorator;
     export declare function Param(name?: string): ParameterDecorator;
     export declare function Body(): ParameterDecorator;
     export declare const Req: () => ParameterDecorator;
     export declare function UseGuards(...guards: unknown[]): MethodDecorator & ClassDecorator;
     export declare const SetMetadata: <K = string, V = unknown>(key: K, value: V) => MethodDecorator & ClassDecorator;
     export declare function createParamDecorator(factory: (data: unknown, context: unknown) => unknown): (...data: unknown[]) => ParameterDecorator;`,
  ),
  ...stubPackage(
    "@nestjs/graphql",
    "13.1.0",
    `export declare function Resolver(): ClassDecorator;
     export declare function Mutation(): MethodDecorator;
     export declare function Query(): MethodDecorator;
     export declare function Args(name: string): ParameterDecorator;`,
  ),
  ...stubPackage("db", "1.0.0", "export declare const db: { save(row: object): Promise<void>; find(id: string): Promise<object> };"),
};

const db = defineAdapter({ name: "db", packages: ["db"], effects: [{ on: "*.save", kind: "db.write" }, { on: "*.find", kind: "db.read" }], lookups: ["*.find"] });

const prelude = `
  import { Controller, Injectable, Get, Post, Delete, Param, Body, Req, UseGuards, SetMetadata, createParamDecorator } from "@nestjs/common";
  import { Resolver, Mutation, Query, Args } from "@nestjs/graphql";
  import { db } from "db";
  const CurrentUser = createParamDecorator((data, context) => ({ id: "1" }));
  const Roles = (...roles: string[]) => SetMetadata("roles", roles);
  const Allow = (...permissions: string[]) => SetMetadata("permissions", permissions);
  class PoliciesGuard {}
  @Injectable()
  class Orders {
    async cancel(id: string) { await db.save({ id }); }
    async find(id: string) { return db.find(id); }
  }`;

describe("nestjs adapter", () => {
  it("finds controllers' route handlers and resolvers' queries and mutations", () => {
    expect(
      entryPointsOf(nestjs, {
        files,
        code: `${prelude}
          @Controller("orders")
          class OrdersController {
            @Get() list() { return []; }
            @Post(":id/cancel") cancel(@Param("id") id: string) { return id; }
          }
          @Resolver()
          class OrdersResolver {
            @Query() order(@Args("id") id: string) { return id; }
            @Mutation() deleteOrder(@Args("id") id: string) { return id; }
          }`,
      }),
    ).toEqual([
      "16: OrdersController.list() (reads)",
      "17: OrdersController.cancel()",
      "21: OrdersResolver.order() (reads)",
      "22: OrdersResolver.deleteOrder()",
    ]);
  });

  it("passes handlers that take the user asking, read it from the request, or are guarded on the method or class", () => {
    expect(
      findingsOf([nestjs, db], {
        files,
        code: `${prelude}
          @Controller("orders")
          class OrdersController {
            constructor(private readonly orders: Orders) {}
            @Post(":id/cancel") cancel(@Param("id") id: string) { return this.orders.cancel(id); }
            @Post(":id/rename") rename(@Param("id") id: string, @CurrentUser() user: { id: string }) { return this.orders.cancel(id); }
            @Post(":id/archive") @Roles("admin") archive(@Param("id") id: string) { return this.orders.cancel(id); }
            @Post() create(@Req() req: { user: { id: string } }, @Body() body: { id: string }) { return db.save({ ...body, owner: req.user.id }); }
            @Get(":id") show(@Param("id") id: string) { return this.orders.find(id); }
          }
          @Controller("admin")
          @UseGuards(PoliciesGuard)
          class AdminController {
            constructor(private readonly orders: Orders) {}
            @Delete(":id") remove(@Param("id") id: string) { return this.orders.cancel(id); }
          }
          @Resolver()
          class OrdersResolver {
            constructor(private readonly orders: Orders) {}
            @Mutation() deleteOrder(@Args("id") id: string) { return this.orders.cancel(id); }
            @Mutation() @Allow("DeleteOrder") purgeOrder(@Args("id") id: string) { return this.orders.cancel(id); }
          }`,
      }),
    ).toEqual([
      "17: unauthorizedWrites: OrdersController.cancel() writes to the database through this.orders.cancel(), which reaches db.save() (sample.ts:11) with nothing checking that the user asking may",
      "21: unauthorizedReads: OrdersController.show() reads a record by a key the request sends through this.orders.find(), which reaches db.find() (sample.ts:12): nothing checks that the user asking may see it",
      "32: unauthorizedWrites: OrdersResolver.deleteOrder() writes to the database through this.orders.cancel(), which reaches db.save() (sample.ts:11) with nothing checking that the user asking may",
    ]);
  });
});
