# Smile Storm AR

浏览器端实时 AR 表情互动原型：微笑触发雨幕，大笑触发烟花，烟花粒子会与跟随头部的椭圆碰撞体反弹。

## 体验流程

1. 点击「开启摄像头」并允许权限。
2. 自然微笑：进入 `SMILE`，开始下雨。
3. 张嘴大笑并收紧脸颊：进入 `LAUGH`，触发烟花。
4. 在烟花绽放时移动头部，粒子会沿头部轮廓反弹。

所有摄像头帧与表情系数均在本机浏览器内处理，不上传视频。

## 架构

```text
Camera (getUserMedia)
  └─ FaceTracker — 约 17 FPS 的独立定时推理
      ├─ MediaPipe Face Landmarker / Blendshapes
      ├─ EMA 平滑 + 头部椭圆拟合
      └─ ExpressionMachine
          ├─ NEUTRAL
          ├─ SMILE → rain
          └─ LAUGH → fireworks
                         └─ lightweight ellipse collision

requestAnimationFrame — 60 FPS 混合渲染
  ├─ PixiJS illustrated rain pool
  └─ Three.js WebGL fireworks
      ├─ Rocket core + luminous trail
      ├─ 250–480 interactive burst particles
      └─ 980–1,600 decorative fine sparks / glow
```

- 推理与渲染使用独立调度；MediaPipe 不在每个 `requestAnimationFrame` 中运行。
- 表情状态含持续时间、滞回阈值和烟花冷却，避免临界值抖动与重复爆发。
- 520 个雨滴在启动时一次性预分配；Fireworks 使用 Three.js `ShaderMaterial` + `THREE.AdditiveBlending`，分为火箭核心、连续微粒尾迹、250–480 个 CPU 交互粒子和 980–1,600 个 GPU-friendly 氛围粒子。
- 烟花粒子使用软圆点 shader（中心高亮、边缘渐隐）叠加局部 `EffectComposer` / `UnrealBloomPass`，只对高亮粒子做 Bloom；同时配合 gravity、drag、turbulence、速度拖尾、生命周期和轻微 z-depth 衰减。装饰层不参与头部碰撞，避免把视觉密度转化为同等规模的物理开销。
- 物理只计算 Main Interactive 烟花粒子与单个动态椭圆的碰撞，不引入通用物理引擎；使用上一帧位置的 swept 检测、头部相对速度、0.74 restitution、外推回弹和 80ms 碰撞高亮，避免高速粒子穿透脸部。
- 调试面板支持显示 Head Collider、Collision Points 和每秒碰撞频率；正式模式默认隐藏这些辅助图层。
- 像素密度上限为 1.5；页面隐藏时暂停推理；MediaPipe GPU 不可用时自动回退 CPU。

## 本地运行

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

摄像头只可在 HTTPS 或 localhost 安全上下文中使用。模型与 WASM 已随站点静态资源一起打包。

## 调试

HUD 会显示 Smile、Jaw Open、Cheek Squint、面部检测状态、推理 FPS、渲染 FPS 和逐帧碰撞数。

无摄像头环境下可用以下组合键做视觉验收：

- `Alt + S`：模拟 `SMILE`
- `Alt + L`：模拟 `LAUGH`
- `Alt + N`：回到 `NEUTRAL`

## Vibecoding 复盘（200 字内）

最大陷阱是把 MediaPipe 塞进 60 FPS 渲染循环，并为每个粒子创建刚体，导致主线程卡顿和 GC 峰值。改为 17 FPS 独立推理、EMA 状态机、预分配粒子池与单椭圆碰撞。纠偏 Prompt：「禁止逐帧推理和通用物理引擎；分离 inference/render，并用对象池与轻量椭圆反射完成头部碰撞。」

## Interaction reference

The camera-start loading interaction is an original lightweight implementation inspired by [Da7em by Da7_Tech](https://da7tech.com) — licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The particle target, colors, loading states, and implementation were adapted for Smile Storm AR.
