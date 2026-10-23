# Hotwire City（热线之城）

一个在浏览器里玩的俯视角 2D 偷车与警匪追逐游戏，用原生 JavaScript 和 Canvas 2D 写成。

**在线试玩：<https://appleweiping.github.io/hotwire-city/>**（桌面浏览器，需要键盘和鼠标）

![偷车之后被警察追](docs/screenshots/chase.gif)

这是我在 [Overdrive City](https://github.com/appleweiping/overdrive-city) 之前写的原型：
先用俯视角 2D 验证"没有引擎、没有素材也能做出有交通、行人和警察反应的小城市"这个想法。
Overdrive City 把同样的思路（瓦片地图城市、单参数漂移、热度通缉）搬到了 3D，并加入了
随机任务和昼夜循环。想玩完整一点的版本请去那边；这个仓库更小、更容易读。

## 本地运行

```bash
git clone https://github.com/appleweiping/hotwire-city.git
cd hotwire-city
python -m http.server 8000
# 打开 http://localhost:8000，按任意键开始
```

## 操作

| 按键 | 步行 | 驾驶 |
|---|---|---|
| `W` `A` `S` `D` | 移动 | 油门、转向、刹车与倒车 |
| 鼠标 | 瞄准，左键射击 | |
| `Shift` | 冲刺 | |
| `Space` | | 手刹（漂移） |
| `E` 或 `Enter` | 上车 / 抢车 | 下车 |
| `1` `2` `3` 或 `Q` | 选择 / 切换武器 | |
| `M` | 静音 | 静音 |
| `Esc` 或 `P` | 暂停 | 暂停 |

## 玩法

开枪、抢车、撞人、袭警都会增加热度，热度到 10、30、60、100、150 分别对应一到五星。
警察先步行出动，然后开车，三星起开始撞你，五星会在前方设路障。只有 8 秒内没有新罪行、
也没有警察看得到你，热度才会下降。死亡显示 **FLATLINED**（现金 −30%，在医院门口复活），
被捕显示 **CUFFED**（现金 −20% 并没收枪支，在警察局门口复活）。没有 Game Over，最高现金纪录
保存在浏览器里。

## 实现要点

- 固定 60 Hz 仿真步长，固定 1280×720 逻辑视口并按窗口等比缩放。
- 92 × 92 的瓦片城市由固定种子生成并存在 `Uint8Array` 里，碰撞、视线和车道方向都直接查数组。
- 车速拆成纵向和横向，横向按 `exp(−grip·dt)` 衰减，手刹只是降低 `grip`。
- 静态地面预渲染进 512 px 的离屏画布分块，刹车痕直接画进分块里。
- 一帧内产生的事件下一帧才交给 AI，警察不会在开枪的同一帧做出反应。

所有数值都在 [`src/config.js`](src/config.js)，详细说明见 [docs/DESIGN.md](docs/DESIGN.md)。

## 许可

MIT。灵感来自 90 年代末的俯视角犯罪游戏，但没有使用它们的代码、美术、名称或音频，与任何发行商无关。
