// Release builds are desktop applications; a console subsystem keeps an empty
// Windows Terminal window open for the lifetime of the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    yunwei_lib::run();
}
