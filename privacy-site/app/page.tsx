import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "枝句 · 生图词库收录器",
  description: "无需账号和配套服务，在 Chrome 本地收录、整理与复用 Prompt。",
};

export default function Home() {
  return (
    <main>
      <header className="hero">
        <div className="eyebrow">LOCAL PROMPT LIBRARY</div>
        <h1>枝句</h1>
        <p className="lead">从网页收录视觉描述，在 Chrome 本地整理、审核、搜索并一键复制 Prompt。</p>
        <div className="actions">
          <a className="button primary" href="/downloads/zhiju-prompt-collector-v0.2.0.zip">
            下载免服务安装包 v0.2.0
          </a>
          <a className="button secondary" href="/privacy">
            查看隐私政策
          </a>
        </div>
      </header>

      <section className="panel" aria-labelledby="install-title">
        <div className="section-number">01</div>
        <h2 id="install-title">解压即可安装</h2>
        <ol className="steps">
          <li>下载并解压安装包。</li>
          <li>打开 <code>chrome://extensions</code>，开启开发者模式。</li>
          <li>选择“加载未打包的扩展程序”，打开安装包内的 <code>extension</code> 目录。</li>
          <li>打开扩展侧栏，立即开始使用。</li>
        </ol>
        <p className="note">不需要 Node.js、账号或配对。词库保存在扩展自己的 IndexedDB 中，不会上传。</p>
      </section>

      <section className="feature-grid" aria-label="主要功能">
        <article>
          <span>收录</span>
          <h2>选中文字，右键保存</h2>
          <p>只处理你主动选择的网页文字，并原样写入浏览器本地词库。</p>
        </article>
        <article>
          <span>整理</span>
          <h2>拆成可复用的枝句</h2>
          <p>在侧栏中编辑、分类并人工审核，不依赖远程模型。</p>
        </article>
        <article>
          <span>备份</span>
          <h2>随时导入与导出</h2>
          <p>用 JSON 备份迁移词库；导入前会验证内容与引用关系。</p>
        </article>
      </section>

      <footer>
        <span>枝句 · 生图词库收录器</span>
        <a href="/privacy">隐私政策</a>
      </footer>
    </main>
  );
}
