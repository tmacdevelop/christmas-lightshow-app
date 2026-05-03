//! Color-space helpers.

use controller::Rgb;

/// Convert HSV (`h` in `[0, 1)`, `s` and `v` in `[0, 1]`) to 8-bit RGB.
///
/// The hue wraps modulo 1.0 so callers can pass any finite value.
#[must_use]
pub fn hsv_to_rgb(h: f32, s: f32, v: f32) -> Rgb {
    let h = h.rem_euclid(1.0) * 6.0;
    let s = s.clamp(0.0, 1.0);
    let v = v.clamp(0.0, 1.0);

    let c = v * s;
    let x = c * (1.0 - ((h % 2.0) - 1.0).abs());
    let m = v - c;

    let (r, g, b) = match h as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };

    Rgb(
        ((r + m) * 255.0).round() as u8,
        ((g + m) * 255.0).round() as u8,
        ((b + m) * 255.0).round() as u8,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primaries_are_correct() {
        assert_eq!(hsv_to_rgb(0.0, 1.0, 1.0), Rgb(255, 0, 0));
        assert_eq!(hsv_to_rgb(1.0 / 3.0, 1.0, 1.0), Rgb(0, 255, 0));
        assert_eq!(hsv_to_rgb(2.0 / 3.0, 1.0, 1.0), Rgb(0, 0, 255));
    }

    #[test]
    fn zero_saturation_is_grayscale() {
        assert_eq!(hsv_to_rgb(0.5, 0.0, 1.0), Rgb(255, 255, 255));
        assert_eq!(hsv_to_rgb(0.5, 0.0, 0.0), Rgb(0, 0, 0));
    }

    #[test]
    fn hue_wraps() {
        assert_eq!(hsv_to_rgb(2.0, 1.0, 1.0), hsv_to_rgb(0.0, 1.0, 1.0));
        assert_eq!(hsv_to_rgb(-0.5, 1.0, 1.0), hsv_to_rgb(0.5, 1.0, 1.0));
    }
}
