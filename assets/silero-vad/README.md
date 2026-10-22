# Silero VAD model

The bundled ONNX model runs locally on CPU before audio reaches the recognition service.

- Upstream: https://github.com/snakers4/silero-vad
- Commit: `066409f3d9db45a30d21dfcbf9147826ffdd7052`
- File: `src/silero_vad/data/silero_vad.onnx`
- SHA-256: `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`
- License: MIT; the original text is in [LICENSE](LICENSE).

Inference uses ONNX Runtime 1.22.0 to retain Intel macOS support. The installer's `adm-zip` dependency is overridden to the patched 0.6.1 release.
