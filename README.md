# 黎安话事运营后台

运营人员用来审核内容、处理举报、管理首页与店铺，以及制作图文和管理企微推送的 Web 后台。前端为原生 HTML、CSS 和 JavaScript，后端为 Node.js，业务数据可接入微信云开发 CloudBase。

## 本地运行

以下命令从仓库根目录执行。交接快照使用 Node.js 24 验证。

```sh
npm --prefix admin ci
cp -n admin/.env.example admin/.env
```

打开 `admin/.env`，设置自己的 `ADMIN_PASSWORD`，保持 `ADMIN_LOCAL=1` 和 `WECOM_AUTO_SEND=0`。启动后访问 [本地后台](http://127.0.0.1:8787)，默认账号为 `admin`。

```sh
npm --prefix admin start
npm --prefix admin test
```

演示数据在首次访问相关功能时生成于 `admin/data/local-store.json`。管理员和成员的登录会话存放在进程内，重启后需重新登录。

## 代码入口

| 路径 | 用途 |
| --- | --- |
| `admin/server.js` | HTTP 入口、登录、权限检查和 API 路由 |
| `admin/public/` | 运营后台页面、样式和浏览器脚本 |
| `admin/lib/` | 运营功能、本地存储和 CloudBase 适配 |
| `admin/scripts/` | 商家同步、好店海报和历史数据回填 |
| `utils/`、`server/` | 共享规则和环境变量加载器 |
| `scripts/` | 内容审核和分类的现有测试 |

## 外部集成

- CloudBase 联调使用独立测试环境。在 `admin/.env` 中填写 `TCB_ENV`、`TCB_SECRET_ID`、`TCB_SECRET_KEY`，并设置 `ADMIN_LOCAL=0`。Shell 中已有的非空环境变量优先，随后为 `server/.env`、`admin/.env`。
- 企微、小程序和飞书的配置项见 [环境变量模板](admin/.env.example)。企微自动推送由 `WECOM_AUTO_SEND=1` 启用。
- 商家同步默认输出预览。联调飞书读取需安装并授权 `lark-cli`，同步附件使用 FFmpeg。确认预览后才使用 `--apply` 写库。
- 好店海报脚本通过 Chrome 渲染，可用 `CHROME_BIN` 指定浏览器。复现海报字体时，在 `admin/assets/poster-fonts/` 放置 `NotoSansSC.ttf`、`NotoSerifSC.ttf` 和 `Oswald.ttf`。
- 生产凭据、部署配置和线上数据由项目负责人通过独立渠道交接。这个仓库记录的是 2026-11-15 的后台源码快照，线上部署版本需在接手时另行核对。
