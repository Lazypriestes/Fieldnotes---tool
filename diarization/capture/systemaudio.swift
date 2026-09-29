// systemaudio — capture macOS system (or one app's) audio via ScreenCaptureKit,
// with NO virtual driver and NO output rerouting (BlackHole-free).
//
// Emits the fixed Fieldnotes capture CONTRACT on stdout:
//     raw PCM, 16 kHz, mono, float32, little-endian
// so it pipes straight into `pipeline.py --source stdin`. Swap this program for any
// other that honours the same contract and nothing else changes.
//
// Logs go to STDERR; stdout is data only.
//
//   ./systemaudio                       # all system audio (excludes our own output)
//   ./systemaudio --app "Microsoft Teams"   # only that app's audio (best effort)
//
// Needs Screen-Recording permission for the launching app (Terminal/iTerm) — granted
// once in System Settings › Privacy & Security › Screen Recording. Far less invasive
// than BlackHole: your default output and volume keys are untouched.

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

let TARGET_SR = 16000.0

func log(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

// ---- args ----
var appMatch: String? = nil
do {
    var i = 1
    let a = CommandLine.arguments
    while i < a.count {
        if a[i] == "--app", i + 1 < a.count { appMatch = a[i + 1]; i += 2 } else { i += 1 }
    }
}

// ---- audio sink: converts each buffer to 16 kHz mono f32 and writes to stdout ----
final class Sink: NSObject, SCStreamOutput, SCStreamDelegate {
    let out = FileHandle.standardOutput
    var converter: AVAudioConverter?
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                               sampleRate: TARGET_SR, channels: 1, interleaved: true)!

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sb),
              let fmtDesc = CMSampleBufferGetFormatDescription(sb) else { return }
        let srcFormat = AVAudioFormat(cmAudioFormatDescription: fmtDesc)

        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
        guard frames > 0,
              let inBuf = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: frames) else { return }
        inBuf.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(
                sb, at: 0, frameCount: Int32(frames),
                into: inBuf.mutableAudioBufferList) == noErr else { return }

        if converter == nil { converter = AVAudioConverter(from: srcFormat, to: target) }
        guard let conv = converter else { return }

        let outCap = AVAudioFrameCount(Double(frames) * TARGET_SR / srcFormat.sampleRate) + 32
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: outCap) else { return }
        var err: NSError?
        var fed = false
        conv.convert(to: outBuf, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return inBuf
        }
        if let e = err { log("convert error: \(e.localizedDescription)"); return }

        let n = Int(outBuf.frameLength)
        if n > 0, let ch = outBuf.floatChannelData {
            out.write(Data(bytes: ch[0], count: n * MemoryLayout<Float>.size))
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("stream stopped: \(error.localizedDescription)"); exit(1)
    }
}

// ---- set up & run ----
let sink = Sink()

func makeFilter(_ content: SCShareableContent) -> SCContentFilter? {
    guard let display = content.displays.first else { log("no display available"); return nil }
    if let name = appMatch {
        let apps = content.applications.filter {
            $0.applicationName.localizedCaseInsensitiveContains(name)
        }
        if apps.isEmpty { log("no running app matching '\(name)'"); return nil }
        log("capturing audio from: \(apps.map { $0.applicationName }.joined(separator: ", "))")
        return SCContentFilter(display: display, including: apps, exceptingWindows: [])
    }
    log("capturing all system audio (excluding this process)")
    return SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
}

func start() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false,
                                                                            onScreenWindowsOnly: false)
        guard let filter = makeFilter(content) else { exit(1) }

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = Int(TARGET_SR)     // requested; AVAudioConverter fixes it if ignored
        cfg.channelCount = 1
        cfg.width = 2; cfg.height = 2        // we don't use video; keep it tiny
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: cfg, delegate: sink)
        try stream.addStreamOutput(sink, type: .audio,
                                   sampleHandlerQueue: DispatchQueue(label: "fn.audio"))
        try await stream.startCapture()
        log("started (16 kHz mono f32 -> stdout). ctrl-c to stop.")
    } catch {
        log("cannot start capture: \(error.localizedDescription)")
        log("grant Screen Recording to your terminal in System Settings › Privacy & Security.")
        exit(1)
    }
}

// clean stop on signal so the parent can kill us without a crash log
signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

Task { await start() }
RunLoop.main.run()
