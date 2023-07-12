function sampleFileInput(id, func) {
    const box = document.getElementById(id);
    box.onchange = function() {
        const file = box.files[0];
        if (!file)
            return;
        func(file, box);
    };
}

async function sampleDemux(file) {
    const libav = await LibAV.LibAV({noworker: true});
    await libav.mkreadaheadfile("input", file);

    const [fmt_ctx, streams] = await libav.ff_init_demuxer_file("input");

    const configs = await Promise.all(streams.map(stream => {
        if (stream.codec_type === libav.AVMEDIA_TYPE_AUDIO)
            return LibAVWebCodecsBridge.audioStreamToConfig(libav, stream);
        else if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO)
            return LibAVWebCodecsBridge.videoStreamToConfig(libav, stream);
        else
            return null;
    }));

    const pkt = await libav.av_packet_alloc();
    const [, packets] = await libav.ff_read_multi(fmt_ctx, pkt);

    libav.terminate();

    return [streams, configs, packets];
}

async function sampleMux(filename, codec, packets, extradata) {
    const libavPackets = [];
    for (const packet of packets) {
        const ab = new ArrayBuffer(packet.byteLength);
        packet.copyTo(ab);
        const pts = ~~(packet.timestamp / 1000);
        libavPackets.push({
            data: new Uint8Array(ab),
            pts, ptshi: 0,
            dts: pts, dtshi: 0,
            flags: (packet.type === "key") ? 1 : 0
        });
    }

    const libav = await LibAV.LibAV({noworker: true});

    /* Decode a little bit (and use extradata) just to make sure everything
     * necessary for a header is in place */
    let [, c, pkt, frame] = await libav.ff_init_decoder(codec);
    await libav.AVCodecContext_time_base_s(c, 1, 1000);
    await libav.ff_decode_multi(c, pkt, frame, [libavPackets[0]]);
    if (extradata) {
        const extradataPtr = await libav.malloc(extradata.length);
        await libav.copyin_u8(extradataPtr, extradata);
        await libav.AVCodecContext_extradata_s(c, extradataPtr);
        await libav.AVCodecContext_extradata_size_s(c, extradata.length);
    }

    // Now mux it
    const [oc, , pb] = await libav.ff_init_muxer(
        {filename, open: true}, [[c, 1, 1000]]);
    await libav.avformat_write_header(oc, 0);
    await libav.ff_write_multi(oc, pkt, libavPackets);
    await libav.av_write_trailer(oc);
    await libav.ff_free_muxer(oc, pb);
    const ret = await libav.readFile(filename);
    libav.terminate();
    return ret;
}

async function decodeAudio(init, packets, stream) {
    // Feed them into the decoder
    const frames = [];
    const decoder = new AudioDecoder({
        output: frame => frames.push(frame),
        error: x => alert(x)
    });
    decoder.configure(init);
    for (const packet of packets) {
        let pts = packet.ptshi * 0x100000000 + packet.pts;
        if (pts < 0)
            pts = 0;
        const ts = Math.round(
            pts * stream.time_base_num / stream.time_base_den *
            1000000);
        decoder.decode(new EncodedAudioChunk({
            type: "key",
            timestamp: ts,
            data: packet.data
        }));
    }

    // Wait for it to finish
    await decoder.flush();
    decoder.close();

    // And output
    const out = [];
    const copyOpts = {
        planeIndex: 0,
        format: "f32-planar"
    };
    for (const frame of frames) {
        const ab = new ArrayBuffer(frame.allocationSize(copyOpts));
        frame.copyTo(ab, copyOpts);
        out.push(new Float32Array(ab));
    }

    return out;
}

async function sampleOutputAudio(a) {
    // Quick concat
    const blob = new Blob(a);
    a = new Float32Array(await blob.arrayBuffer());

    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    const w = canvas.width = 1024;
    const h = canvas.height = 64;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    for (let x = 0; x < w; x++) {
        const idx = Math.floor((x / w) * a.length);
        const y = h - (h * Math.abs(a[idx]));
        ctx.fillStyle = "#fff";
        ctx.fillRect(x, 0, 1, y);
        ctx.fillStyle = "#0f0";
        ctx.fillRect(x, y, 1, h - y);
    }
}

async function decodeVideo(init, packets, stream) {
    // Feed them into the decoder
    const frames = [];
    const decoder = new VideoDecoder({
        output: frame => frames.push(frame),
        error: x => alert(x)
    });
    decoder.configure(init);
    for (const packet of packets) {
        let pts = packet.ptshi * 0x100000000 + packet.pts;
        if (pts < 0)
            pts = 0;
        const ts = Math.round(
            pts * stream.time_base_num / stream.time_base_den *
            1000000);
        decoder.decode(new EncodedVideoChunk({
            type: (packet.flags & 1) ? "key" : "delta",
            timestamp: ts,
            data: packet.data
        }));
    }

    // Wait for it to finish
    await decoder.flush();
    decoder.close();

    return frames;
}

function sampleOutputVideo(v, fps) {
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    const w = canvas.width = v[0].codedWidth;
    const h = canvas.height = v[0].codedHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    let idx = 0;
    const interval = setInterval(async () => {
        const image = await createImageBitmap(v[idx++]);
        ctx.drawImage(image, 0, 0);

        if (idx >= v.length)
            idx = 0;
    }, Math.round(1000 / fps))
}
