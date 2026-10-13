import SwiftUI

public struct SQLResultTableView: View {
    public let title: String
    public let columns: [String]
    public let rows: [[String]]
    public let rawQuery: String?
    
    @Environment(\.colorScheme) private var colorScheme
    
    public init(
        title: String = "DATA TABLE",
        columns: [String],
        rows: [[String]],
        rawQuery: String? = nil
    ) {
        self.title = title
        self.columns = columns
        self.rows = rows
        self.rawQuery = rawQuery
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        
        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack {
                HStack(spacing: 5) {
                    Image(systemName: "tablecells.fill")
                        .font(.scaled(11, relativeTo: .caption2))
                        .foregroundColor(Color(hex: "#3ECF8E"))
                    Text(title.uppercased())
                        .font(.scaled(9.5, weight: .heavy, relativeTo: .caption2))
                        .foregroundColor(Color(hex: "#3ECF8E"))
                }
                
                Spacer()
                
                Text("\(rows.count) rows")
                    .font(.scaled(10, weight: .bold, relativeTo: .caption2))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2.5)
                    .background(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
                    .clipShape(Capsule())
            }
            
            // Raw Query if present
            if let query = rawQuery, !query.isEmpty {
                Text(query)
                    .font(.scaled(10, design: .monospaced, relativeTo: .caption2))
                    .foregroundColor(isDark ? Color(hex: "#F8FAFC") : Color(hex: "#0F172A"))
                    .lineLimit(2)
                    .padding(6)
                    .background(isDark ? Color.black.opacity(0.4) : Color.black.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            
            // Scrollable Grid
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 4) {
                    // Column Headers
                    HStack(spacing: 12) {
                        ForEach(Array(columns.enumerated()), id: \.offset) { _, col in
                            Text(col.uppercased())
                                .font(.scaled(9.5, weight: .heavy, design: .monospaced, relativeTo: .caption2))
                                .foregroundColor(Color(hex: "#3ECF8E"))
                                .frame(minWidth: 65, alignment: .leading)
                        }
                    }
                    .padding(.bottom, 2)
                    // One stop for the header row, so the columns are named
                    // once rather than being implied by whatever the reader
                    // has already swiped past.
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Columns: \(columns.joined(separator: ", "))")

                    Divider().background(isDark ? Color.white.opacity(0.12) : Color.black.opacity(0.08))

                    // Rows
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        HStack(spacing: 12) {
                            ForEach(Array(columns.indices), id: \.self) { colIdx in
                                let val = colIdx < row.count ? row[colIdx] : ""
                                Text(val)
                                    .font(.scaled(10, design: .monospaced, relativeTo: .caption2))
                                    .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                                    .frame(minWidth: 65, alignment: .leading)
                            }
                        }
                        .padding(.vertical, 1.5)
                        // Without this every cell is its own stop: eight
                        // columns is eighty swipes to hear one row, with no
                        // way to tell which column a value belongs to. The
                        // label pairs each value with its column name.
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(Self.speakableRow(columns: columns, row: row))
                    }
                }
            }
            
            Divider().background(isDark ? Color.white.opacity(0.12) : Color.black.opacity(0.08))
            
            // Footer
            HStack {
                Button {
                    let csv = ([columns] + rows)
                        .map { $0.map(Self.csvField).joined(separator: ",") }
                        .joined(separator: "\n")
                    PlatformBridge.copyToPasteboard(csv)
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "doc.on.doc")
                        Text("Copy CSV")
                    }
                    .font(.caption2.weight(.medium))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                }
                .buttonStyle(.plain)
                
                Spacer()
            }
        }
        .padding(10)
        // The one material the chrome is made of (Glass.swift), replacing a
        // gradient stacked under a second material. The green stroke and the
        // shadow stay — they are what mark this as a result set.
        .glassRounded(cornerRadius: 12, interactive: false)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(hex: "#3ECF8E").opacity(0.35), lineWidth: 0.8)
        )
        .shadow(color: Color.black.opacity(isDark ? 0.20 : 0.04), radius: 4, y: 1.5)
    }

    /// "name: value, name: value" — the same row a sighted reader reads
    /// across, spoken in that order rather than as a column of bare numbers.
    private static func speakableRow(columns: [String], row: [String]) -> String {
        columns.enumerated().map { index, name in
            "\(name): \(index < row.count ? row[index] : "")"
        }.joined(separator: ", ")
    }

    private static func csvField(_ value: String) -> String {
        guard value.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" || $0 == "\r" }) else {
            return value
        }
        return "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}
