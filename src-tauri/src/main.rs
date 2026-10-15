// debug 也用 GUI 子系统：否则 dev 模式附带控制台，截图等全屏操作后会被顶到前台
#![windows_subsystem = "windows"]

fn main() {
    file_line_lib::run()
}
