// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

fn main() {
    quadruped_robot_research_lib::run();
}
