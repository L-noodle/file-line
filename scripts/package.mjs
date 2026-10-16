// 打包辅助脚本
//   node scripts/package.mjs sync     —— 将 package.json 的 version 同步到 tauri.conf.json / Cargo.toml
//   node scripts/package.mjs collect  —— 收集打包产物到 release/ 并按规范命名
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeIfChanged = (p, content) => {
  if (fs.readFileSync(p, "utf8") !== content) fs.writeFileSync(p, content, "utf8");
};

function sync() {
  const version = readJson(path.join(root, "package.json")).version;

  // tauri.conf.json：控制安装包名（{productName}_{version}_{arch}-setup.exe）
  const confPath = path.join(root, "src-tauri", "tauri.conf.json");
  const conf = readJson(confPath);
  conf.version = version;
  writeIfChanged(confPath, JSON.stringify(conf, null, 2) + "\n");

  // Cargo.toml：仅替换 [package] 段的第一处 version
  const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
  writeIfChanged(
    cargoPath,
    fs
      .readFileSync(cargoPath, "utf8")
      .replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`)
  );

  console.log(`版本号已同步: ${version}`);
}

function collect() {
  const version = readJson(path.join(root, "package.json")).version;
  const targetRelease = path.join(root, "src-tauri", "target", "release");
  const outDir = path.join(root, "release");
  fs.mkdirSync(outDir, { recursive: true });

  // 绿色免装版：裸 exe，前端资源已内嵌，可独立运行
  const exeSrc = ["file-line.exe", "FileLine.exe"]
    .map((n) => path.join(targetRelease, n))
    .find((p) => fs.existsSync(p));
  if (!exeSrc) {
    console.error(`未找到 release exe（${targetRelease}），请先执行 tauri build`);
    process.exit(1);
  }
  const portablePath = path.join(outDir, `FileLine_${version}绿色免装版.exe`);
  fs.copyFileSync(exeSrc, portablePath);
  console.log(`绿色免装版: ${portablePath}`);

  // 安装包：NSIS 产物原名即为 FileLine_{version}_{arch}-setup.exe
  const nsisDir = path.join(targetRelease, "bundle", "nsis");
  const setupName = fs
    .readdirSync(nsisDir)
    .find((f) => f.startsWith(`FileLine_${version}_`) && f.endsWith("-setup.exe"));
  if (setupName) {
    const setupPath = path.join(outDir, setupName);
    fs.copyFileSync(path.join(nsisDir, setupName), setupPath);
    console.log(`安装包: ${setupPath}`);
  } else {
    console.warn(`未在 ${nsisDir} 找到 FileLine_${version}_*-setup.exe`);
  }
}

if (mode === "sync") sync();
else if (mode === "collect") collect();
else {
  console.error("用法: node scripts/package.mjs <sync|collect>");
  process.exit(1);
}
