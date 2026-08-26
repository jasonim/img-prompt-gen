# Data contract

版本 0.2.x 的产品真源是扩展源域下 IndexedDB 数据库 `zhiju-library` 中的单一 `current` 快照。快照包含 `schemaVersion`、单调递增的 `revision`、可编辑 `state` 和同事务生成的只读 `runtime`。所有写入使用 revision 前置条件和原子事务。

## Capture

同一 capture ID 与相同正文重复写入是幂等的；同一 ID 对应不同正文会冲突。正文必须逐字保留，不得在存储前裁剪、总结或改写。

必需字段：`recordType`、`id`、精确 `text`、`capturedAt`、扩展生成的 `receivedAt`、`sourceType=browser_selection`、`processingStatus`、`processedAt`、`derivedTermIds` 和 `derivedRecipeIds`。

## Terms, recipes, prompts

- Term：一个可独立替换的可见控制，分别记录浏览 `category` 和系统 `responsibility`。
- Recipe：有序 term ID、来源 capture ID 和保留的完整 Prompt。
- Prompt：用户手动维护、用于重复复制的完整指令。

每个实体分别记录机器校验和人工审核。人工批准绑定规范化内容的 SHA-256；时间与审核元数据不参与哈希，所有发布字段参与。发布字段变化会撤销批准，term 变化还会在同一事务中降级依赖的已批准 recipe。

## Publication matrix

- 结构无效：拒绝整个事务，旧快照保持不变。
- 机器有效、人工待审核：保留在真源与整理台，排除在 runtime 外。
- 需返修：保留并隔离。
- 人工批准、哈希仍匹配且依赖有效：进入 runtime。
- 已批准 recipe 引用未批准或不存在的 term：拒绝。

## 备份

导出格式包含 `schemaVersion=1`、`sourceRevision`、`exportedAt` 以及 `captures`、`terms`、`recipes`、`prompts`。导入不信任备份的旧 revision；它会完整验证内容，并以当前 revision 的下一版本原子替换数据库。备份不包含 URL、标题、Token、Cookie 或浏览历史。

## Limits

- Capture 和完整 Prompt：最多 48 KiB UTF-8。
- Term 显示名：最多 24 个 Unicode code point。
