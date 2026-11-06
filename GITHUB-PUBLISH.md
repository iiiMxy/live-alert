# GitHub 发布文案

复制粘贴用。仓库名、描述、Topics、Release 正文都在下面。

---

## 1. 仓库名

推荐用中性、可搜索的名字：

```
live-alert
```

如果想更具体：

```
multi-platform-live-alert
```
```
bilibili-douyin-kick-live-alert
```

**不建议**用 `quin-live-alert`——把某个主播写进仓库名，会让别人以为这是专用工具，也让项目难以被搜到。

---

## 2. 仓库描述（About，限 350 字符）

**中文版（推荐，约 90 字）**

```
Tampermonkey 脚本：同时监控 B站 / 抖音 / Kick 的直播间，开播时弹出带封面和标题的系统通知。内置 Mr.Quin 三路直播间作为默认配置，可在设置面板中增删或清空。
```

**英文版（约 150 字符）**

```
A Tampermonkey userscript that watches Bilibili / Douyin / Kick live rooms and fires a native desktop notification with cover and title when a stream goes live. Ships with a ready-to-use default list; fully editable in the in-page settings panel.
```

**极简版（如果要更短）**

```
监控 B站 / 抖音 / Kick 直播间，开播时弹出系统通知。Tampermonkey userscript.
```

---

## 3. Topics（GitHub 仓库标签）

```
tampermonkey  userscript  livestream  live-alert  notification  bilibili  douyin  kick  edge  javascript
```

GitHub 的 topics 只接受小写字母、数字和连字符，上面这些都合规。建议至少保留前五个。

---

## 4. Release：v1.0.0

**Tag**

```
v1.0.0
```

**Release 标题**

```
v1.0.0 — 首个可用版本
```

**Release 正文**

```markdown
一个 Tampermonkey 脚本：同时盯 B站 / 抖音 / Kick 的直播间，开播时弹出带封面和标题的系统通知。

## 功能

- **三平台**：B站、抖音、Kick，各自独立判定，互不影响
- **开箱即用**：内置 Mr.Quin 的 B站 / 抖音 / Kick 三路直播间作为初始配置
- **可增删**：设置面板里逐条添加 / 停用 / 删除，支持粘贴整条链接自动识别平台，也支持批量添加
- **合并通知**：多个平台同一分钟开播合成一条，附封面与直播标题，点击直达直播间
- **开播历史**：记录每场的开始 / 结束时间与时长，可查看最近 20 条
- **状态面板**：可收起的角落小胶囊，绿=在播 / 灰=未播 / 红=数据源异常
- **不误报**：只在「上次明确未开播 → 这次开播」时提醒；接口异常只亮红，不猜状态

## 安装

1. 装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开 `live-alert.user.js` 的 Raw 地址，点「安装」
3. 打开任意一个直播间页面（如 `https://live.bilibili.com/`）

装好后默认就在监控 Mr.Quin 的三路直播间，无需配置。

## 不关注默认列表？

设置 → 监控对象 → 逐条删除 / 停用，或在「重置」里一键「清空监控对象」。
清空是可选项，之后也能用「恢复默认列表」找回。

## 已知限制

- 必须有一个标签页常驻，关掉就停止监控
- Edge 的「睡眠标签页」会冻结脚本，需要把站点加入「永不休眠」
- 后台标签页的定时器被浏览器节流到约 1 次/分钟，提醒最多延迟 1 分钟
- 抖音走的是非公开的 `reflow/info` 接口，随时可能失效；失效时面板变红，B站与 Kick 不受影响
- 电脑关机 / 休眠 / 断网时不监控

详见 README。
```

---

## 5. 发布步骤清单

- [x] `@namespace` 已指向 `https://github.com/iiiMxy/live-alert`
- [x] `@author` 与 `LICENSE` 版权人已填 `iMxy_`
- [ ] 仓库设为 Public，勾选 **Add a README file** 时直接用本地的 `README.md` 覆盖
- [ ] 添加 Topics（见上）
- [ ] 在 About 右侧填「描述」和「Website」（可选：设为 Raw 安装链接）
- [ ] 创建 Release，Tag 填 `v1.0.0`，正文用上面那段
- [ ] 把 `live-alert.user.js` 作为 Release 附件上传（可选，方便没装 git 的人直接下）
- [ ] 复制 Raw 链接自测一次：新开一个浏览器配置文件，从零装一遍，确认能跑

> 账号与署名是有意分开的：GitHub 用户名用 `iiiMxy`（可含连字符/字母，不含下划线），脚本里的作者署名保留 `iMxy_`。建仓前确认 `https://github.com/iiiMxy` 能打开。

---

## 6. 可选：让 Tampermonkey 自动更新

用户从 Raw 链接安装时，TM 默认会定期回读同一个地址检查 `@version`。只要：

- 文件路径保持不变
- 每次更新递增 `@version`

就能自动更新，**不需要**额外配 `@downloadURL`。

如果之后同时发到 Greasy Fork，再把 GF 提供的 `@downloadURL` / `@updateURL` 补进文件头，让两边都能更新。

---

## 7. 一句话定位（用于社交媒体 / 论坛发帖）

```
写了个油猴脚本：同时监控 B站 / 抖音 / Kick 的直播间，开播时右下角弹带封面的系统通知，还能记录开播历史。默认盯的是 Mr.Quin 的三路，不关注他也可以自己加任意直播间。
```
