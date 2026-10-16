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
  let changed = false;

  // tauri.conf.json：控制安装包名（{productName}_{version}_{arch}-setup.exe）
  const confPath = path.join(root, "src-tauri", "tauri.conf.json");
  const conf = readJson(confPath);
  if (conf.version !== version) {
    conf.version = version;
    writeIfChanged(confPath, JSON.stringify(conf, null, 2) + "\n");
    changed = true;
  }

  // Cargo.toml：仅替换 [package] 段的第一处 version
  const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
  const cargoSrc = fs.readFileSync(cargoPath, "utf8");
  const cargoVersion = cargoSrc.match(/^version\s*=\s*"([^"]*)"/m)?.[1];
  if (cargoVersion !== version) {
    writeIfChanged(cargoPath, cargoSrc.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`));
    changed = true;
  }

  console.log(changed ? `版本号已同步: ${version}` : `版本号已是 ${version}，无需写入`);
}

// 在目录中查找匹配的产物（找不到时给出告警）
function findIn(dir, predicate) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).find(predicate) ?? null;
}

function collectWindows(targetRelease, outDir, productName, version) {
  let found = false;

  // 绿色免装版：裸 exe，前端资源已内嵌，可独立运行
  const exeName = findIn(targetRelease, (f) => f === `${productName}.exe` || f === "file-line.exe");
  if (exeName) {
    const portablePath = path.join(outDir, `${productName}_${version}绿色免装版.exe`);
    fs.copyFileSync(path.join(targetRelease, exeName), portablePath);
    console.log(`绿色免装版: ${portablePath}`);
    found = true;
  } else {
    console.warn(`未找到 release exe（${targetRelease}）`);
  }

  // 安装包：NSIS 产物原名即为 {productName}_{version}_{arch}-setup.exe
  const nsisDir = path.join(targetRelease, "bundle", "nsis");
  const setupName = findIn(
    nsisDir,
    (f) => f.startsWith(`${productName}_${version}_`) && f.endsWith("-setup.exe")
  );
  if (setupName) {
    const setupPath = path.join(outDir, setupName);
    fs.copyFileSync(path.join(nsisDir, setupName), setupPath);
    console.log(`安装包: ${setupPath}`);
    found = true;
  } else {
    console.warn(`未在 ${nsisDir} 找到 ${productName}_${version}_*-setup.exe`);
  }

  return found;
}

function collectMacos(targetRelease, outDir, productName, version) {
  let found = false;

  // DMG 安装包：产物原名即为 {productName}_{version}_{arch}.dmg
  const dmgDir = path.join(targetRelease, "bundle", "dmg");
  const dmgName = findIn(
    dmgDir,
    (f) => f.startsWith(`${productName}_${version}_`) && f.endsWith(".dmg")
  );
  if (dmgName) {
    const dmgPath = path.join(outDir, dmgName);
    fs.copyFileSync(path.join(dmgDir, dmgName), dmgPath);
    console.log(`安装包: ${dmgPath}`);
    found = true;
  } else {
    console.warn(`未在 ${dmgDir} 找到 ${productName}_${version}_*.dmg`);
  }

  // .app 应用程序包：拷贝整个目录
  const macosDir = path.join(targetRelease, "bundle", "macos");
  const appName = findIn(macosDir, (f) => f === `${productName}.app` || f.endsWith(".app"));
  if (appName) {
    const appPath = path.join(outDir, appName);
    fs.rmSync(appPath, { recursive: true, force: true });
    fs.cpSync(path.join(macosDir, appName), appPath, { recursive: true });
    console.log(`应用程序: ${appPath}`);
    found = true;
  } else {
    console.warn(`未在 ${macosDir} 找到 ${productName}.app`);
  }

  return found;
}

function collectLinux(targetRelease, outDir, productName, version) {
  const bundleDir = path.join(targetRelease, "bundle");
  if (!fs.existsSync(bundleDir)) return false;

  let found = false;
  for (const kind of ["deb", "appimage", "rpm"]) {
    const dir = path.join(bundleDir, kind);
    const name = findIn(dir, (f) => f.includes(version) || f.startsWith(productName));
    if (!name) continue;
    const dest = path.join(outDir, name);
    if (fs.statSync(path.join(dir, name)).isDirectory()) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(dir, name), dest, { recursive: true });
    } else {
      fs.copyFileSync(path.join(dir, name), dest);
    }
    console.log(`${kind} 包: ${dest}`);
    found = true;
  }
  return found;
}

function collect() {
  const version = readJson(path.join(root, "package.json")).version;
  const productName =
    readJson(path.join(root, "src-tauri", "tauri.conf.json")).productName ?? "file-line";
  const targetRelease = path.join(root, "src-tauri", "target", "release");
  const outDir = path.join(root, "release");

  if (!fs.existsSync(targetRelease)) {
    console.error(`未找到构建目录（${targetRelease}），请先执行 tauri build`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const collectors = { win32: collectWindows, darwin: collectMacos, linux: collectLinux };
  const collect_ = collectors[process.platform];
  if (!collect_) {
    console.error(`暂不支持当前平台: ${process.platform}`);
    process.exit(1);
  }

  if (!collect_(targetRelease, outDir, productName, version)) {
    console.error("未收集到任何产物，请先执行 tauri build");
    process.exit(1);
  }
}

if (mode === "sync") sync();
else if (mode === "collect") collect();
else {
  console.error("用法: node scripts/package.mjs <sync|collect>");
  process.exit(1);
}
