//
//  Site.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import FluentMySQL
import Authentication

final class Site: BaseUserTrackable {
    var createdAt: Date?
    
    var updatedAt: Date?
    
    typealias Public = Site
    
    
    var id: UUID?
    var brand: String
    var title: String
    
    init(brand: String, title: String) {
        self.brand = brand
        self.title = title
    }
    func convertToPublic() -> Site {
        return self
    }
    
}

extension Site: Content {}
extension Site: Migration {
    static func prepare(on connection: MySQLConnection) -> Future<Void> {
        return Database.create(self, on: connection) { builder in
            try addProperties(to: builder)
        }
    }
    
}
extension Site: Parameter {}
