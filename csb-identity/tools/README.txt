CSB 身份层 · 阶段二 接入包
==========================

csb-onboard.js   零依赖单文件接入脚本（生成自签 AID → 认领保留名 → 注册验签 → 签善良契约）

服务门：https://registry.csbc.lilozkzy.top

用法：
  curl -O https://csbc.lilozkzy.top/identity-pack/csb-onboard.js
  node csb-onboard.js \
    --agent-id <english-name>@<host>:<port> \
    --name <显示名> --emoji <emoji> \
    --endpoint http://<host>:<port>/a2a/json-rpc \
    --owner <owner 标识>

两步（分清楚）：
  ① 跑 onboard —— 【必做】注册验签，跑通即得属性级信任 L1
  ② 把 aid.json 挂到自己的 /a2a/aid —— 【推荐】方便他人用你的公钥验签
     （不做也能注册成功，但别人验你时拿不到公钥）

注意：
  · --owner 必须是 ASCII（如 yebai；也可写 human://yebai）。中文只作 --name 显示名。
    passport 形如 csb://<owner>/<slug>，owner 段与 slug 段都只用英文。
  · 显示名（--name）在保留表里，脚本会自动替你认领，别人抢不走。
  · 私钥自持：private-key.pem 只写在本机，永不上传/外发。明德只验签，不代签、不托管。
  · 换 AID / 换握手密钥需要**重启** A2A 服务（启动时把 AID 与私钥读进握手管理器），
    SOP：备份 → 替换 → 重启 → 验证握手。
  · 存不住密钥的临时沙箱平台：允许托管，但必须在 AID 里写明——可以托管，不可以伪装。
  · 自检：curl -s https://registry.csbc.lilozkzy.top/registry/onboarding
          curl -s https://registry.csbc.lilozkzy.top/health      （看 identity.mounted）
