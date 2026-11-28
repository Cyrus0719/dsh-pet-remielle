# 蕾米埃尔桌宠 · dsh-pet-remielle-desktop

[![npm](https://img.shields.io/npm/v/dsh-pet-remielle-desktop?color=f2a0c0&label=npm)](https://www.npmjs.com/package/dsh-pet-remielle-desktop)
[![stars](https://img.shields.io/github/stars/Cyrus0719/dsh-pet-remielle?color=f2a0c0&label=stars)](https://github.com/Cyrus0719/dsh-pet-remielle/stargazers)
[![license](https://img.shields.io/npm/l/dsh-pet-remielle-desktop?color=f2a0c0)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-f2a0c0)](#安装)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-f2a0c0)](https://github.com/topics/dsh-plugin)

[English](README.en.md) | 简体中文

常驻 Windows 桌面的**全帧透明桌宠**：754 帧原画动画、真正的 DSH 智能体会话、图片与 emoji、四向自适应聊天卡片。她不是网页里的贴纸，是一个能替你干活的桌面搭子。

![演示](docs/demo.gif)

## 她为什么值得留在桌面上

- **真桌面窗**：独立 Neutralino 窗口（透明 / 无边框 / 置顶 / 不进任务栏），6 个状态的原生 340×304 动画 WebP（待机、思考、工具调用、边想边写、等待、完成），30 ms 原始帧率，放大也不糊。
- **能干活**：在桌面上说一句话，她就开一个真实的 DSH 智能体会话去做（当前工作区、workspace-write）。调工具、跑命令、读文件的全过程都发生在 DSH 里，会话同时出现在 Web GUI，可以接着聊、接着派活。
- **图片与 emoji**：输入框 ＋ 发图（png/jpg/webp/gif/bmp，最多 4 张）；她的回复 emoji 彩色渲染，回复里的图片路径或 URL 自动内联成缩略图，点开看大图。
- **四向自适应**：她在屏幕右半边，聊天卡片向左展开；在左半边，向右展开；靠近上下边缘自动收进屏幕。开合聊天时她本人一动不动。
- **全屏让位**：前台是全屏游戏或全屏视频时自动取消置顶并隐藏，退出全屏自动回来。
- **可拖可收可关**：右上角 − / + / × 调整大小与收起；64×64 小圆可以像宠物一样拖动，单击展开。右键菜单只有「退出」，退出后在 DSH 会话里发 `/pet on` 就能叫回来。
- **记得住**：对话、位置、缩放都落盘；重启 DSH 后接着说。
- **接着上次聊的**：打开聊天时，她会用模型把最近几轮对话总结成 1–2 条具体、可执行的下一步，点一下就直接发出去；没有可延续的目标就不打扰你。

## 已收录

| 市场 | 状态 |
| --- | --- |
| [dsh-plugin.org](https://dsh-plugin.org/zh/plugins/cyrus0719/dsh-pet-remielle) | ✅ 已收录 |
| [WhaleHub](https://whalehub-dsh.vercel.app) | ✅ 已收录（fun） |
| [DSH Market](https://github.com/2BingLing/dsh-market) | ✅ 已收录 |
| [npm](https://www.npmjs.com/package/dsh-pet-remielle-desktop) | ✅ 已发布 |
| dsh-plugin-hub / DSH-Store / dsh-plugin-shop / awesome-dsh-plugin / awesome-deepseek-harness / dsh-go-market | 🕓 审核中 |

> 如果觉得好用，请给一颗 star 吧~

## 安装

要求：Windows 10/11、DSH 0.2.x 及以上。运行时已内置，安装时不跑构建脚本，不需要 allowBuilds。

### 从 npm 安装（推荐）

```
plugin_manager install_bundle target="npm:dsh-pet-remielle-desktop"
```

命令行等价写法：

```bash
dsh plugin --profile <profile> add dsh-pet-remielle-desktop
```

### 从 GitHub 安装

```
plugin_manager install_bundle target="github:Cyrus0719/dsh-pet-remielle"
```

### 从本地目录安装

```
plugin_manager install_bundle target="file:C:/Users/<你>/dsh-pet-remielle"
```

装好即启用；没看到窗口就确认插件条目是 active。改过插件代码后把条目关掉再打开一次即可重载。

runtime/neutralino-win_x64.exe 丢了的话，执行 `node scripts/install-neutralino.mjs` 重新下载。

### 卸载

```
plugin_manager remove_bundle target="dsh-pet-remielle-desktop"
```

再删掉 `%USERPROFILE%\.dsh\desktop-pet`（对话、位置、缩放都在里面）。

## 用

| 操作 | 结果 |
| --- | --- |
| 单击宠物 | 开 / 关聊天卡片 |
| 右键宠物 | 「退出」（之后在 DSH 会话里发 `/pet on` 叫回来）；下方小字可去 GitHub 给颗 star |
| 拖动宠物 | 换位置（记住） |
| 宠物右上角 − / + | 缩小 / 放大（0.5×–2×，0.25 步进，记住） |
| 宠物右上角 × | 收起成 64×64 圆形徽章 |
| 拖动小圆 / 单击小圆 | 换位置（记住） / 展开回宠物 |
| 聊天头部 ⟲ / ↗ / × | 新会话 / 在 DSH Web GUI 打开该会话 / 收起聊天 |
| 输入框 ＋ | 选图片发给她（最多 4 张） |
| Enter / Shift+Enter | 发送 / 换行 |

「退出」会结束窗口和它自己的进程，插件本身仍然开着。叫回来的办法：

1. 在任意 DSH 会话里发 `/pet on`（`/pet off` 等同完全关闭）；
2. 把插件面板里的 dsh-pet-remielle-desktop 关掉再启用一次。

只想暂时收起来就点右上角的 ×，位置和对话都不会丢。

## 数据放在哪

- `%USERPROFILE%\.dsh\desktop-pet\chat.json` — 最近 60 条对话 + 当前会话 id
- `%USERPROFILE%\.dsh\desktop-pet\position.json` — 窗口坐标
- `%USERPROFILE%\.dsh\desktop-pet\ui.json` — 缩放比例

对话本体在 DSH 会话里（chat.json 只是摘录），所以能在 DSH Web GUI 的会话历史里找到同一个 session 继续聊。

## 宠物素材与换宠物

`assets/pets/remielle/pet.json`：

```json
{
  "id": "remielle",
  "displayName": "蕾米埃尔",
  "cell": [340, 304],
  "animations": {
    "idle": "anims/idle.webp",
    "thinking": "anims/thinking.webp",
    "tool": "anims/tool.webp",
    "review": "anims/review.webp",
    "waiting": "anims/waiting.webp",
    "done": "anims/done.webp"
  }
}
```

换宠物：在 `assets/pets/<id>/` 放同名结构的 `pet.json` + 透明动画 WebP，把 `cordis.patch.yml` 里的 `petId` 改掉；也可以放进 `%USERPROFILE%\.dsh\desktop-pet\pets\<id>\`（用户目录优先于包内）。

## 1.3.0 更新

- 打开聊天时新增「接着上次聊的」建议：用模型总结最近对话，给出 1–2 条具体、可点击执行的下一步。
- 删掉固定的打招呼、三个预设问题与首次启动自动弹窗。
- 右键菜单精简为「退出」，Star 入口改成一行小字「如果觉得好用，请给一颗 star 吧~」，带 ⭐ 和 ↗ 提示可点击。
- 修复：建议卡片被输入条渐变遮住、长建议只显示两行。

## 实现说明

- 窗口后端、状态机、宠物目录约定来自 [dsh-desktop-pet](https://github.com/sereinmono/dsh-desktop-pet)（MIT）。
- 本包在它基础上的工作：原生分辨率动画帧流（不再用 8×9 精灵图）、聊天卡片（真实 DSH 会话 / 图片 / emoji / 四向布局 / 自动滚到底）、状态机修复（`tool/result` 不回落导致「一直画画」、断开会话残留任务）、全屏让位、缩放与位置持久化、可拖动收起徽章、去托盘、基于最近对话的 AI 下一步建议。
- 前端是 `assets/neutralino/resources/index.html` 一份文件；host 是 `lib/index.js`。

## 素材与署名（重要）

- 素材作者：**HanaAyane / 小蕾米** — https://github.com/HanaAyane/remielle-codex-pet
- 衍生自《绝区零》同人素材，动作经人工逐帧整理 + AI 辅助重绘；本包只做格式转换（GIF → 透明 WebP）。
- **仅限个人非商业同人使用**：禁止销售、付费分发、改名冒充、商标注册，禁止暗示米哈游 / HoYoverse 官方授权。转发请保留署名与仓库链接。
- 详见 [NOTICE.md](NOTICE.md) 与 [ASSET-USAGE.md](ASSET-USAGE.md)。

## 许可

代码：MIT（见 [LICENSE](LICENSE)，含上游 dsh-desktop-pet 的 MIT 声明）。
内置宠物素材：不适用 MIT，版权归 HanaAyane / 小蕾米，仅限个人非商业同人使用。
