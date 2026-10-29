import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import AppKit

struct CaptureFailure: Error {
    let code: String
    let message: String
}

@main
struct CaptureMain {
    static func emit(_ value: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print(text) }
    }

    static func bounds(_ rect: CGRect) -> [String: CGFloat] {
        return ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
    }

    @MainActor static func main() async {
        // A command-line process needs an AppKit connection before querying
        // window filter geometry through WindowServer.
        _ = NSApplication.shared
        do {
            guard CommandLine.arguments.count == 2,
                  let input = CommandLine.arguments[1].data(using: .utf8),
                  let request = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
                throw CaptureFailure(code: "capture_invalid_request", message: "Expected one JSON request")
            }
            guard CGPreflightScreenCaptureAccess() else {
                throw CaptureFailure(code: "capture_permission_denied", message: "Enable Screen & System Audio Recording for the app running this server in System Settings, then restart the server")
            }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            if request["operation"] as? String == "list" {
                let displays: [[String: Any]] = content.displays.map { display in
                    let frame = CGDisplayBounds(display.displayID)
                    return ["id": display.displayID, "bounds": bounds(frame),
                            "width": frame.width, "height": frame.height,
                            "scale": CGFloat(CGDisplayPixelsWide(display.displayID)) / frame.width]
                }
                let windows: [[String: Any]] = content.windows.map { window in
                    return ["id": window.windowID, "title": window.title ?? "",
                            "application": window.owningApplication?.applicationName ?? "", "bounds": bounds(window.frame)]
                }
                emit(["displays": displays, "windows": windows, "coordinateSpace": "logical-points"])
                return
            }
            guard request["operation"] as? String == "capture",
                  let target = request["target"] as? [String: Any],
                  let kind = target["kind"] as? String,
                  let output = request["outputPath"] as? String,
                  let maxPixels = request["maxPixels"] as? Double else {
                throw CaptureFailure(code: "capture_invalid_request", message: "Missing capture target, pixel budget, or output path")
            }
            let filter: SCContentFilter
            let rect: CGRect
            if kind == "window" {
                guard let id = target["windowId"] as? UInt32,
                      let window = content.windows.first(where: { $0.windowID == id }) else {
                    throw CaptureFailure(code: "capture_target_missing", message: "Window is no longer available; list capture targets again")
                }
                filter = SCContentFilter(desktopIndependentWindow: window)
                rect = CGRect(origin: .zero, size: filter.contentRect.size)
            } else {
                guard let id = target["displayId"] as? UInt32,
                      let display = content.displays.first(where: { $0.displayID == id }) else {
                    throw CaptureFailure(code: "capture_target_missing", message: "Display is no longer available; list capture targets again")
                }
                filter = SCContentFilter(display: display, excludingWindows: [])
                let size = CGDisplayBounds(id).size
                if kind == "region" {
                    guard let x = target["x"] as? Double, let y = target["y"] as? Double,
                          let width = target["width"] as? Double, let height = target["height"] as? Double,
                          x.isFinite, y.isFinite, width.isFinite, height.isFinite,
                          x >= 0, y >= 0, width > 0, height > 0, x + width <= size.width, y + height <= size.height else {
                        throw CaptureFailure(code: "capture_invalid_region", message: "Region must fit inside the display's logical bounds")
                    }
                    rect = CGRect(x: x, y: y, width: width, height: height)
                } else if kind == "display" { rect = CGRect(origin: .zero, size: size) }
                else { throw CaptureFailure(code: "capture_invalid_request", message: "Unknown capture target kind") }
            }
            let scale = Double(filter.pointPixelScale)
            let pixelWidth = ceil(rect.width * scale), pixelHeight = ceil(rect.height * scale)
            guard pixelWidth > 0, pixelHeight > 0, pixelWidth * pixelHeight <= maxPixels else {
                throw CaptureFailure(code: "image_dimensions_exceeded", message: "Capture exceeds pixel budget; choose a smaller region")
            }
            let config = SCStreamConfiguration()
            config.width = Int(pixelWidth)
            config.height = Int(pixelHeight)
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            if kind == "region" { config.sourceRect = rect }
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
                throw CaptureFailure(code: "capture_write_failed", message: "Could not create capture output")
            }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else {
                throw CaptureFailure(code: "capture_write_failed", message: "Could not finish capture output")
            }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output)
            emit(["target": target, "scale": scale, "logicalBounds": bounds(rect), "capturedAt": ISO8601DateFormatter().string(from: Date())])
        } catch let failure as CaptureFailure { emit(["error": failure.message, "code": failure.code]) }
        catch { emit(["error": error.localizedDescription, "code": "capture_failed"]) }
    }
}
