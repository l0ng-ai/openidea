use std::io::{Cursor, Error, ErrorKind, Result};

/// A top-down BITMAPV5HEADER and BGRA pixels. The alpha mask lets native paste targets
/// retain transparency; the PNG flavor is also written for browsers and image editors.
pub(crate) fn png_to_dib(png: &[u8]) -> Result<Vec<u8>> {
    let invalid = |error| Error::new(ErrorKind::InvalidData, error);
    let mut decoder = png::Decoder::new(Cursor::new(png));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(invalid)?;
    let rgba_size = (reader.info().width as usize)
        .checked_mul(reader.info().height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .filter(|size| *size <= 64 * 1024 * 1024)
        .ok_or_else(|| Error::new(ErrorKind::InvalidData, "Clipboard image is too large"))?;
    let size = reader
        .output_buffer_size()
        .filter(|size| *size <= 64 * 1024 * 1024)
        .ok_or_else(|| Error::new(ErrorKind::InvalidData, "Clipboard image is too large"))?;
    let mut pixels = vec![0; size];
    let info = reader.next_frame(&mut pixels).map_err(invalid)?;
    let mut dib = vec![0; 124];
    dib[0..4].copy_from_slice(&124u32.to_le_bytes());
    dib[4..8].copy_from_slice(&info.width.to_le_bytes());
    dib[8..12].copy_from_slice(&(-(info.height as i32)).to_le_bytes());
    dib[12..14].copy_from_slice(&1u16.to_le_bytes());
    dib[14..16].copy_from_slice(&32u16.to_le_bytes());
    dib[16..20].copy_from_slice(&3u32.to_le_bytes()); // BI_BITFIELDS
    dib[20..24].copy_from_slice(&(rgba_size as u32).to_le_bytes());
    for (at, value) in [(40, 0x00ff0000u32), (44, 0x0000ff00), (48, 0x000000ff), (52, 0xff000000), (56, 0x73524742)] {
        dib[at..at + 4].copy_from_slice(&value.to_le_bytes());
    }
    dib[108..112].copy_from_slice(&4u32.to_le_bytes()); // LCS_GM_IMAGES
    for pixel in pixels[..info.buffer_size()].chunks_exact(info.color_type.samples()) {
        let rgba = match info.color_type {
            png::ColorType::Rgba => [pixel[0], pixel[1], pixel[2], pixel[3]],
            png::ColorType::Rgb => [pixel[0], pixel[1], pixel[2], 255],
            png::ColorType::Grayscale => [pixel[0], pixel[0], pixel[0], 255],
            png::ColorType::GrayscaleAlpha => [pixel[0], pixel[0], pixel[0], pixel[1]],
            png::ColorType::Indexed => unreachable!("palette expansion requested"),
        };
        dib.extend_from_slice(&[rgba[2], rgba[1], rgba[0], rgba[3]]);
    }
    Ok(dib)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(color: png::ColorType, pixels: &[u8]) -> Vec<u8> {
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 1, 2);
            encoder.set_color(color);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(pixels).unwrap();
        }
        png
    }

    #[test]
    fn keeps_rgba_colors_alpha_and_top_down_row_order() {
        let png = encode(png::ColorType::Rgba, &[255, 0, 0, 128, 0, 255, 0, 255]);
        let dib = png_to_dib(&png).unwrap();
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), -2);
        assert_eq!(&dib[124..], &[0, 0, 255, 128, 0, 255, 0, 255]);
        let round_trip = crate::dib_to_png(&dib).unwrap();
        let mut reader = png::Decoder::new(Cursor::new(round_trip)).read_info().unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut pixels).unwrap();
        assert_eq!(pixels, [255, 0, 0, 128, 0, 255, 0, 255]);
    }

    #[test]
    fn supports_rgb_and_grayscale_without_assuming_an_alpha_channel() {
        for (color, pixels, expected) in [
            (png::ColorType::Rgb, vec![255, 0, 0, 0, 255, 0], vec![0, 0, 255, 255, 0, 255, 0, 255]),
            (png::ColorType::Grayscale, vec![20, 200], vec![20, 20, 20, 255, 200, 200, 200, 255]),
            (png::ColorType::GrayscaleAlpha, vec![20, 10, 200, 250], vec![20, 20, 20, 10, 200, 200, 200, 250]),
        ] {
            assert_eq!(&png_to_dib(&encode(color, &pixels)).unwrap()[124..], expected);
        }
        assert!(png_to_dib(b"not a PNG").is_err());
    }
}
