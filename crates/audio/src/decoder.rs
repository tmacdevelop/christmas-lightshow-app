//! Audio file decoder using `symphonia`.
//!
//! Decodes any supported format (MP3, WAV, OGG Vorbis, FLAC, AAC) from raw
//! bytes and returns interleaved mono i16 samples at the native sample rate.

use std::io::Cursor;

use symphonia::core::{
    audio::SampleBuffer, codecs::DecoderOptions, errors::Error as SymphoniaError,
    formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
};

/// Decode `data` (raw audio file bytes) to a mono i16 sample vector.
///
/// Multi-channel audio is down-mixed to mono by averaging channels.
/// Returns `(samples, sample_rate_hz)`.
pub fn decode_to_mono(data: &[u8]) -> anyhow::Result<(Vec<i16>, u32)> {
    let cursor = Cursor::new(data.to_vec());
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

    let hint = Hint::new();
    let format_opts = FormatOptions::default();
    let metadata_opts = MetadataOptions::default();
    let decoder_opts = DecoderOptions::default();

    let probed =
        symphonia::default::get_probe().format(&hint, mss, &format_opts, &metadata_opts)?;

    let mut format = probed.format;

    // Pick the first audio track.
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow::anyhow!("no audio tracks found"))?
        .clone();

    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| anyhow::anyhow!("unknown sample rate"))?;

    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &decoder_opts)?;

    let mut mono_samples: Vec<i16> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<i16>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(pkt) => pkt,
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(e) => return Err(e.into()),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(e)) => {
                tracing::warn!("decode error (skipping packet): {e}");
                continue;
            }
            Err(e) => return Err(e.into()),
        };

        let spec = *decoded.spec();
        let capacity = decoded.capacity();

        let buf = sample_buf.get_or_insert_with(|| SampleBuffer::new(capacity as u64, spec));
        buf.copy_interleaved_ref(decoded);

        let channels = spec.channels.count();
        let interleaved = buf.samples();

        if channels == 1 {
            mono_samples.extend_from_slice(interleaved);
        } else {
            // Down-mix: average all channels per frame.
            for frame in interleaved.chunks_exact(channels) {
                let avg = frame.iter().map(|&s| s as i32).sum::<i32>() / channels as i32;
                mono_samples.push(avg.clamp(i16::MIN as i32, i16::MAX as i32) as i16);
            }
        }
    }

    if mono_samples.is_empty() {
        anyhow::bail!("decoded zero samples — unsupported or empty file");
    }

    Ok((mono_samples, sample_rate))
}
