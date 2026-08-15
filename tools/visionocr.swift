/*
 * visionocr — read text out of an image with Apple Vision, print observations
 * as JSON in the same shape js/ocr.js produces.
 *
 * DEVELOPMENT TOOL. Not part of the shipped web app, which cannot reach Vision
 * from a browser. This exists so the real pipeline can be exercised end to end
 * on a Mac with the engine that actually works, and to model what an iOS
 * Shortcut would hand back.
 *
 * No perspective correction here: the page has already flattened the photo from
 * the four dragged corners, and warping twice loses detail.
 *
 * Build:  swiftc -O tools/visionocr.swift -o tools/visionocr
 */
import Foundation
import Vision
import CoreImage

struct Obs: Codable {
    let text: String
    let conf: Float
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

let args = CommandLine.arguments
guard args.count >= 2, let img = CIImage(contentsOf: URL(fileURLWithPath: args[1])) else {
    FileHandle.standardError.write("usage: visionocr <image>\n".data(using: .utf8)!)
    exit(1)
}

let handler = VNImageRequestHandler(ciImage: img, options: [:])
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false          // it "corrects" times into words
req.recognitionLanguages = ["en-GB", "en-US"]
req.minimumTextHeight = 0.0

do {
    try handler.perform([req])
} catch {
    FileHandle.standardError.write("recognition failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

let obs: [Obs] = (req.results ?? []).compactMap { o in
    guard let top = o.topCandidates(1).first else { return nil }
    let b = o.boundingBox                    // normalized, bottom-left origin
    return Obs(text: top.string,
               conf: top.confidence,
               x: Double(b.minX),
               y: Double(1.0 - b.maxY),      // convert to top-left origin
               w: Double(b.width),
               h: Double(b.height))
}

let enc = JSONEncoder()
enc.outputFormatting = [.sortedKeys]
FileHandle.standardOutput.write(try enc.encode(obs))
