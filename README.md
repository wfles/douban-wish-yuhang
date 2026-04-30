# 豆瓣想读 x 余杭图书馆

在豆瓣「想读」页面一键查询余杭区图书馆在馆可借书籍，显示索书号和馆藏位置。

## 功能

- 自动翻页采集全部想读书单
- 按书名搜索杭州图书馆 OPAC，匹配不到时自动回退到 ISBN 查询
- 只显示余杭区图书馆（主馆）在馆可借的书籍
- 馆藏地点支持筛选
- 支持开始、暂停、停止操作
- 5 路并发查询，300 本书约 1-2 分钟完成

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. [点击安装脚本](https://raw.githubusercontent.com/haoo/douban-wish-yuhang/main/douban-wish-yuhang.user.js)
3. 打开你的豆瓣「想读」页面，点击「开始查询」

## 使用

打开 `https://book.douban.com/people/你的ID/wish`，页面顶部会出现查询面板：

1. 点击「开始查询」
2. 脚本自动采集所有页面书籍，并发查询余杭区图书馆馆藏
3. 查询结果实时显示在汇总表格中
4. 可通过「馆藏地点」下拉菜单筛选具体位置
5. 拿着索书号去书架上找书

## 技术说明

- 直接对接杭州图书馆集群 OPAC 系统（图创 interlib），无第三方中间层
- API 地址：`https://my1.zjhzlib.cn/opac`
- 按 host 限速（OPAC 200ms/请求），避免被屏蔽
- 适配其他使用图创 interlib 的图书馆只需修改 OPAC 地址和馆藏筛选条件

## License

MIT
