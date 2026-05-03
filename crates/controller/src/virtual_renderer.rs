//! In-process renderer that fans frames out to subscribers via a
//! [`tokio::sync::broadcast`] channel.

use std::sync::Arc;

use tokio::sync::broadcast;

use crate::{RenderError, Renderer, Rgb};

/// Receiving half of a [`VirtualRenderer`] frame stream.
///
/// Each item is a packed `[r, g, b, r, g, b, ...]` byte buffer of length
/// `3 * pixel_count`.
pub type FrameSubscriber = broadcast::Receiver<Arc<Vec<u8>>>;

/// A renderer that broadcasts each frame to any number of subscribers.
///
/// Lagging subscribers are dropped from a frame (per `tokio::sync::broadcast`
/// semantics) but the renderer itself never blocks waiting on a slow consumer.
#[derive(Debug)]
pub struct VirtualRenderer {
    pixel_count: usize,
    tx: broadcast::Sender<Arc<Vec<u8>>>,
}

impl VirtualRenderer {
    /// Create a renderer for `pixel_count` pixels with the given broadcast
    /// channel capacity (number of frames buffered per subscriber).
    #[must_use]
    pub fn new(pixel_count: usize, channel_capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(channel_capacity);
        Self { pixel_count, tx }
    }

    /// Subscribe to the frame stream. The returned receiver yields each frame
    /// produced after the call to `subscribe`.
    pub fn subscribe(&self) -> FrameSubscriber {
        self.tx.subscribe()
    }

    /// Number of currently-active subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }

    /// Number of pixels this renderer expects per frame.
    #[must_use]
    pub fn pixel_count(&self) -> usize {
        self.pixel_count
    }

    /// Broadcast a frame using only `&self`.
    ///
    /// Used by adapters that wrap an `Arc<VirtualRenderer>` and need to
    /// publish from the engine's `Renderer::render(&mut self, ...)` method
    /// without exclusive access to the inner renderer.
    pub fn publish(&self, frame: &[Rgb]) -> Result<(), RenderError> {
        if frame.len() != self.pixel_count {
            return Err(RenderError::FrameSizeMismatch {
                expected: self.pixel_count,
                actual: frame.len(),
            });
        }

        let mut bytes = Vec::with_capacity(frame.len() * 3);
        for px in frame {
            bytes.push(px.0);
            bytes.push(px.1);
            bytes.push(px.2);
        }
        let _ = self.tx.send(Arc::new(bytes));
        Ok(())
    }
}

impl Renderer for VirtualRenderer {
    fn pixel_count(&self) -> usize {
        self.pixel_count
    }

    fn render(&mut self, frame: &[Rgb]) -> Result<(), RenderError> {
        self.publish(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn render_broadcasts_packed_bytes_to_subscribers() {
        let mut r = VirtualRenderer::new(3, 4);
        let mut rx = r.subscribe();

        let frame = [Rgb(1, 2, 3), Rgb(4, 5, 6), Rgb(7, 8, 9)];
        r.render(&frame).expect("render");

        let received = rx.recv().await.expect("recv");
        assert_eq!(*received, vec![1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }

    #[test]
    fn render_rejects_wrong_size_frame() {
        let mut r = VirtualRenderer::new(3, 4);
        let err = r.render(&[Rgb::BLACK; 2]).unwrap_err();
        assert!(matches!(
            err,
            RenderError::FrameSizeMismatch {
                expected: 3,
                actual: 2
            }
        ));
    }
}
