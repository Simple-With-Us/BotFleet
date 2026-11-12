// Join two synthetic CI pixel captures without replacing the TV-Face baseline.
import AppKit
import Foundation

let paths = Array(CommandLine.arguments.dropFirst())
guard paths.count == 3,
      let first = NSImage(contentsOfFile: paths[0]),
      let second = NSImage(contentsOfFile: paths[1]),
      first.size.width > 0, second.size.width > 0 else {
    fatalError("Both preview captures must be readable images")
}
let width = first.size.width
let firstHeight = first.size.height
let secondHeight = second.size.height * width / second.size.width
let size = NSSize(width: width, height: firstHeight + secondHeight)
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Preview canvas unavailable")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.white.setFill()
NSRect(origin: .zero, size: size).fill()
first.draw(in: NSRect(x: 0, y: secondHeight, width: width, height: firstHeight))
second.draw(in: NSRect(x: 0, y: 0, width: width, height: secondHeight))
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Preview PNG unavailable")
}
try data.write(to: URL(fileURLWithPath: paths[2]), options: .atomic)
