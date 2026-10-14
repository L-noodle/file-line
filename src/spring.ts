// 弹簧物理（对齐参考项目 stiffness 46 / damping 2.6 / 欠阻尼多周期摆动）。
// 直接驱动 DOM style，避免 React 每帧重渲染。

export class Spring {
  value: number;
  target: number;
  v = 0;
  k: number;
  c: number;
  private raf = 0;
  private last = 0;
  private onUpdate: (v: number) => void;
  private onComplete?: () => void;

  constructor(
    from: number,
    onUpdate: (v: number) => void,
    stiffness = 46,
    damping = 2.6,
    onComplete?: () => void
  ) {
    this.value = from;
    this.target = from;
    this.k = stiffness;
    this.c = damping;
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.onUpdate(from);
  }

  nudge(delta: number) {
    this.v += delta;
    this.ensureRunning();
  }

  to(target: number) {
    this.target = target;
    this.ensureRunning();
  }

  private ensureRunning() {
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number) => {
    // 半隐式欧拉积分，dt 上限防大步失稳
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 1 / 20) dt = 1 / 20;
    const steps = 2; // 细分提高稳定性
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const f = -this.k * (this.value - this.target) - this.c * this.v;
      this.v += f * h;
      this.value += this.v * h;
    }
    this.onUpdate(this.value);
    const settled =
      Math.abs(this.value - this.target) < 0.01 && Math.abs(this.v) < 0.01;
    if (settled) {
      this.value = this.target;
      this.onUpdate(this.target);
      this.raf = 0;
      this.onComplete?.();
    } else {
      this.raf = requestAnimationFrame(this.tick);
    }
  };

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
