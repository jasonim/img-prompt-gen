# 枝句 · 本地生图词库

一个本机运行的 Chrome Manifest V3 生图 Prompt 词库：网页右键收录，侧栏整理与搜索，本地 Node 服务保存分层真源，并把人工批准的内容编译给扩展读取。

## 需要什么

- Google Chrome 116 或更新版本。
- Node.js 24 LTS（实现同时兼容 Node 22–24；当前开发机验证版本见最终报告）。
- 不需要数据库、账号、云服务或第三方 npm 依赖。

## 1. 启动本地服务

在项目根目录运行：

```bash
npm start
```

服务固定监听 `127.0.0.1:43119`。首次启动会在终端显示一条 10 分钟有效的一次性配对密钥。服务不会监听 `0.0.0.0`。

## 2. 加载 Chrome 扩展

1. 打开 `chrome://extensions`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目的 `extension/` 目录。
5. 点击扩展图标或浏览器侧栏中的“枝句”。
6. 把终端显示的配对密钥粘贴到侧栏。只有双向服务证明通过后，扩展才会发送正文。

如果扩展卸载重装、扩展 ID 改变或本地存储被清空，在服务运行时执行：

```bash
npm run pairing:reset
```

## 3. 做一次真实收录

在任意普通网页中选中下面这段公开测试文字：

> 一名短黑发女性俯卧在浅青绿色碎花床铺上。镜头从近距离高位斜着俯拍，双臂在脸下交叠。窗边局部高曝光，画面低对比、轻微柔焦。

右键选择“保存到生图词库”。预期结果：

- 服务在线：侧栏暂存区显示“已同步”；正文写入 `data/captures.jsonl`。
- 服务离线：侧栏显示“仅本地暂存”；重启服务并点击“重试全部”后补写。
- 同一 capture 重试不会产生重复原始记录。

## 4. 整理与批准

在“整理台”打开原始收录，为每个原子词分别判断：

- 浏览分类：以后会去哪个分类找它？
- 视觉职责：它真正改变画面的哪个机制？

保存后内容仍是待审核状态。点击“人工批准”才会进入 `data/runtime/library.json` 和“正式词库”。机器校验通过不会冒充人工批准。

## 5. 验证与回读

```bash
npm run verify
npm run health
npm run read:library
```

- `verify`：契约、语法、80% 覆盖率门禁、真实数据校验和隔离服务 smoke test。
- `health`：认证回读服务、真源计数、runtime 计数和 revision。
- `read:library`：认证回读扩展实际读取的 runtime。

测试使用临时目录和随机端口，不写真实 `data/`。

## 数据分层

```text
data/captures.jsonl        原始收录，保留完整原文
data/terms.json            可独立替换的视觉原子词
data/recipes.json          多词关系和派生完整 Prompt
data/prompts.json          用户手动维护的常用 Prompt
data/runtime/library.json  仅含已通过门禁且经人工批准的派生文件
```

不要手工编辑 `runtime/library.json`。数据修改通过本地 API 进入可恢复 WAL 事务；所有文件必须匹配 `data/CURRENT` revision。

## 隐私与安全

- 默认不保存页面 URL、标题、HTML、Cookie、账号或浏览历史。
- 配对 secret 和 bearer token 位于 `data/.secrets/`，权限为 `0600`，不会进入导出和日志。
- 浏览器暂存同步成功后删除正文，只保留最多 24 小时/200 条短收据。
- 导出内容包含原始 Prompt，备份时请使用你信任的加密存储。
