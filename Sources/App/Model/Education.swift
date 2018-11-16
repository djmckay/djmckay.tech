//
//  Education.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import FluentMySQL
import Authentication

final class Education: BaseUserTrackable {
    var createdAt: Date?
    
    var updatedAt: Date?
    
    typealias Public = Education
    
    
    var id: UUID?
    var title: String
    var summary: String?
    var text: String
    var supportingText: String
    
    init(summary: String?, title: String, text: String, supportingText: String) {
        self.summary = summary
        self.title = title
        self.text = text
        self.supportingText = supportingText
    }
    
    func convertToPublic() -> Education {
        return self
    }
    
}

extension Education: Content {}
extension Education: Migration {
    static func prepare(on connection: MySQLConnection) -> Future<Void> {
        return Database.create(self, on: connection) { builder in
            try addProperties(to: builder)
        }
    }
    
}
extension Education: Parameter {}
