#!/bin/sh
# Sets up relay-asr on the Relay Host (Apple silicon): a uv venv with parakeet-mlx (ASR), livekit
# (WebRTC AEC3) and sherpa-onnx (diarization, live speaker labels) in $RELAY_ASR_HOME (default
# ~/.local/share/relay/asr), the speaker models next to it (pyannote segmentation, TitaNet-small,
# and WeSpeaker ResNet34 for MeetingTranscriber's voice prints), and Parakeet's weights in the
# Hugging Face cache (2.5 GB, first run only). Safe to run again.
set -e
HOME_DIR="${RELAY_ASR_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/relay/asr}"
UV="$(command -v uv || echo /opt/homebrew/bin/uv)"
mkdir -p "$HOME_DIR/models"
cd "$HOME_DIR"
[ -x .venv/bin/python ] || "$UV" venv --python 3.12 .venv
"$UV" pip install --python .venv/bin/python -r "$(dirname "$0")/requirements.txt"

M="$HOME_DIR/models"
if [ ! -f "$M/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" ]; then
	curl -fsSL -o "$M/seg.tar.bz2" https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
	tar -xjf "$M/seg.tar.bz2" -C "$M" && rm "$M/seg.tar.bz2"
fi
[ -f "$M/nemo_en_titanet_small.onnx" ] ||
	curl -fsSL -o "$M/nemo_en_titanet_small.onnx" https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx
[ -f "$M/wespeaker_en_voxceleb_resnet34_LM.onnx" ] ||
	curl -fsSL -o "$M/wespeaker_en_voxceleb_resnet34_LM.onnx" https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx

# Download and load the model once so the first call does not wait for it.
.venv/bin/python -c "from parakeet_mlx import from_pretrained; from_pretrained('mlx-community/parakeet-tdt-0.6b-v3')"
echo "relay-asr ready in $HOME_DIR"
