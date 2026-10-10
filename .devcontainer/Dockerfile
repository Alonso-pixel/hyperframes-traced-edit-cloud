# The render box: Node 22 + ffmpeg + whisper.cpp + headless-Chrome libraries + rclone.
FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm

# ffmpeg from Debian is built with freetype/fontconfig (drawtext, used by the contact sheets).
# The lib* list is what chrome-headless-shell needs (HyperFrames downloads the browser itself).
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive && apt-get install -y --no-install-recommends \
      ffmpeg rclone jq cmake build-essential git ca-certificates curl util-linux \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fontconfig \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libx11-xcb1 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# whisper.cpp, pinned. Portable AVX2 build (the image may be built on a different CPU than the
# one the codespace runs on, so no -march=native).
ARG WHISPER_TAG=v1.7.6
RUN git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp /tmp/whisper \
    && cmake -S /tmp/whisper -B /tmp/whisper/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
         -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DWHISPER_SDL2=OFF \
    && cmake --build /tmp/whisper/build -j"$(nproc)" --target whisper-cli \
    && install -m 0755 /tmp/whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && rm -rf /tmp/whisper
