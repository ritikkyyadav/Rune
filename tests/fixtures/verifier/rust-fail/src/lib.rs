// Deliberately broken: a &str where an i32 belongs. `cargo check` must refuse
// this — that refusal is what the fixture exists to prove.
pub fn add(a: i32, b: i32) -> i32 {
    a + "b"
}
