//
//  Experience.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import FluentMySQL
import Authentication

final class Experience: BaseUserTrackable {
    var createdAt: Date?
    
    var updatedAt: Date?
    
    typealias Public = Experience
    
    
    var id: UUID?
    var header: String
    var title: String
    var summary: String
    var text: String
    var action: String
    var current: Bool
    var location: String
    var sort: Int
    var url: String?
    
    init(header: String, title: String, text: String, summary: String, action: String, current: Bool, location: String, sort: Int, url: String? = nil) {
        self.summary = summary
        self.title = title
        self.text = text
        self.header = header
        self.action = action
        self.current = current
        self.location = location
        self.sort = sort
        self.url = url
    }
        
    func convertToPublic() -> Experience {
        return self
    }
    
}

extension Experience: Content {}
extension Experience: Migration {
    static func prepare(on connection: MySQLConnection) -> Future<Void> {
        return Database.create(self, on: connection) { builder in
            builder.field(for: \.id)
            builder.field(for: \.summary, type: .longtext)
            builder.field(for: \.title)
            builder.field(for: \.text, type: .longtext)
            builder.field(for: \.header)
            builder.field(for: \.current)
            builder.field(for: \.createdAt)
            builder.field(for: \.updatedAt)
            builder.field(for: \.sort)
            builder.field(for: \.url)
        }
    }
    
}
extension Experience: Parameter {}
