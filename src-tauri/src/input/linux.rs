use super::{NativeKey, NativeKeyboardController};
use gtk::{gdk, prelude::*};

fn key_from_event(event: &gdk::EventKey) -> NativeKey {
    match event.keyval() {
        gdk::keys::constants::Escape => NativeKey::Escape,
        gdk::keys::constants::space => NativeKey::Space,
        gdk::keys::constants::Up => NativeKey::Forward,
        gdk::keys::constants::Down => NativeKey::Backward,
        gdk::keys::constants::Left => NativeKey::Left,
        gdk::keys::constants::Right => NativeKey::Right,
        key => match key.to_unicode().map(|value| value.to_ascii_lowercase()) {
            Some('w') => NativeKey::Forward,
            Some('s') => NativeKey::Backward,
            Some('a') => NativeKey::Left,
            Some('d') => NativeKey::Right,
            Some('q') => NativeKey::YawLeft,
            Some('e') => NativeKey::YawRight,
            Some('r') => NativeKey::Reset,
            _ => NativeKey::Other,
        },
    }
}

pub fn install(
    window: &tauri::WebviewWindow,
    controller: NativeKeyboardController,
) -> tauri::Result<()> {
    let gtk_window = window.gtk_window()?;
    let pressed = controller.clone();
    gtk_window.connect_key_press_event(move |_, event| {
        if pressed.handle_key(key_from_event(event), true) {
            gtk::glib::Propagation::Stop
        } else {
            gtk::glib::Propagation::Proceed
        }
    });
    let released = controller.clone();
    gtk_window.connect_key_release_event(move |_, event| {
        if released.handle_key(key_from_event(event), false) {
            gtk::glib::Propagation::Stop
        } else {
            gtk::glib::Propagation::Proceed
        }
    });
    gtk_window.connect_window_state_event(move |_, event| {
        if event.changed_mask().contains(gdk::WindowState::ICONIFIED) {
            controller.set_window_focused(
                !event
                    .new_window_state()
                    .contains(gdk::WindowState::ICONIFIED),
            );
        }
        gtk::glib::Propagation::Proceed
    });
    Ok(())
}
