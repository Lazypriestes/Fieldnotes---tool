// ocr — read the text in an image with macOS's built-in Vision framework (on-device).
// Used by the Import window to turn a photo / screenshot / Miro export of a question
// board into text. One line per recognised text block:
//     x <TAB> y <TAB> width <TAB> height <TAB> text
// x/y/width/height are fractions of the image (0..1), y measured from the TOP.
//
//   swiftc -O ocr.swift -o ocr      (analysis/docimport.py builds it on first use)
//   ./ocr board.png

import AppKit
import Vision

guard CommandLine.arguments.count > 1,
      let img = NSImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!)
    exit(1)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
do {
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
} catch {
    FileHandle.standardError.write("ocr failed: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
for obs in req.results ?? [] {
    guard let best = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox                      // Vision: origin bottom-left
    let text = best.string.replacingOccurrences(of: "\t", with: " ")
    print(String(format: "%.4f\t%.4f\t%.4f\t%.4f\t", b.minX, 1 - b.maxY, b.width, b.height) + text)
}
