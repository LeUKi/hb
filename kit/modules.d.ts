/**
 * judge.js 能 import 的 Node 模块（协议第 4.3 节）：只有这几个，要写 node: 前缀，
 * 写在文件开头。没列在这里的，编辑器会标红，npm test 和网站部署也不让过。
 * 这里只说明能 import 什么，导入的东西没有细的类型。
 */
declare module "node:crypto";
declare module "node:buffer";
declare module "node:util";
declare module "node:zlib";
declare module "node:path";
declare module "node:querystring";
declare module "node:string_decoder";
declare module "node:assert";
declare module "node:url";
declare module "node:events";
