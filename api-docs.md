# API 接口文档

> 本文件描述用户管理模块的核心 HTTP 接口，包括请求参数、响应格式和错误码。

---

## 接口清单

| 编号 | 方法 | 路径 | 说明 |
|------|------|------|------|
| A-01 | `GET` | `/api/users` | 分页查询用户列表 |
| A-02 | `GET` | `/api/users/:id` | 查询单个用户详情 |
| A-03 | `POST` | `/api/users` | 创建新用户 |
| A-04 | `PUT` | `/api/users/:id` | 更新用户信息 |
| A-05 | `DELETE` | `/api/users/:id` | 删除用户 |

---

## 通用说明

### 公共请求头

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `Authorization` | `string` | ✅ | Bearer Token，格式：`Bearer <token>` |
| `X-Request-ID` | `string` | ❌ | 用于链路追踪，不传则服务端自动生成 |
| `X-Lang` | `string` | ❌ | 响应语言，默认 `zh-CN`，可选 `en-US` |

### 通用响应格式

```json
{
  "code": 0,
  "message": "success",
  "data": {},
  "requestId": "abc-123-def"
}
```

---

## 详细接口

### A-01 · 查询用户列表

**请求**

```http
GET /api/users?page=1&pageSize=20&role=admin&keyword=zhang HTTP/1.1
Authorization: Bearer <token>
```

**查询参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | `number` | ❌ | `1` | 页码，从 1 开始 |
| `pageSize` | `number` | ❌ | `20` | 每页数量，最大 100 |
| `role` | `string` | ❌ | — | 角色过滤：`admin` / `user` / `guest` |
| `keyword` | `string` | ❌ | — | 模糊匹配姓名或邮箱 |
| `sortBy` | `string` | ❌ | `createdAt` | 排序字段 |
| `sortOrder` | `string` | ❌ | `desc` | 排序方向：`asc` / `desc` |

**响应 `data` 结构**

| 字段 | 类型 | 说明 |
|------|------|------|
| `items` | `User[]` | 用户对象数组 |
| `total` | `number` | 总记录数 |
| `page` | `number` | 当前页码 |
| `pageSize` | `number` | 每页数量 |

**`User` 对象**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 用户 ID（UUID） |
| `name` | `string` | 姓名 |
| `email` | `string` | 邮箱 |
| `role` | `string` | 角色 |
| `status` | `string` | 状态：`active` / `inactive` / `banned` |
| `createdAt` | `string` | 创建时间（ISO 8601） |
| `updatedAt` | `string` | 更新时间（ISO 8601） |

---

### A-03 · 创建用户

**请求**

```http
POST /api/users HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "张三",
  "email": "zhangsan@example.com",
  "role": "user"
}
```

**请求体参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | ✅ | 姓名，2-50 字符 |
| `email` | `string` | ✅ | 邮箱，需符合 RFC 5322 |
| `role` | `string` | ❌ | 角色，默认 `user` |
| `password` | `string` | ✅ | 密码，最少 8 位，含大小写字母和数字 |

---

## 错误码

| 错误码 | HTTP 状态 | 说明 | 处理建议 |
|--------|-----------|------|----------|
| `0` | — | 成功 | — |
| `1001` | `400` | 参数校验失败 | 检查请求体格式 |
| `1002` | `401` | Token 无效或已过期 | 重新获取 Token |
| `1003` | `403` | 权限不足 | 联系管理员开通权限 |
| `1004` | `404` | 资源不存在 | 确认 ID 是否正确 |
| `1005` | `409` | 邮箱已存在 | 换用其他邮箱 |
| `1006` | `429` | 请求过于频繁 | 降低请求频率或申请提额 |
| `1999` | `500` | 服务器内部错误 | 稍后重试或联系运维 |

---

## 版本记录

| 日期 | 版本 | 变更说明 |
|------|------|---------|
| 2026-09-07 | v1.0.0 | 初始版本，覆盖用户管理全部接口 |
| — | — | — |

---

*维护团队：Platform API Team · 最后更新：2026-09-07*
