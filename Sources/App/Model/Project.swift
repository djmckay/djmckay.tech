//
//  Project.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import FluentMySQL
import Authentication

final class Project: BaseUserTrackable {
    var createdAt: Date?
    
    var updatedAt: Date?
    
    typealias Public = Project
    
    
    var id: UUID?
    var name: String
    var description: String
    var url: String?
    var github: String?
    var imageURL: String?
    var sort: Int
    
    init(name: String, description: String, url: String?, github: String?, imageURL: String?, sort: Int) {
        self.url = url
        self.name = name
        self.description = description
        self.github = github
        self.imageURL = imageURL
        self.sort = sort
    }
    
    func convertToPublic() -> Project {
        return self
    }
    
}

extension Project: Content {}
extension Project: Migration {
    static func prepare(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.create(Project.self, on: conn, closure: { (builder) in
            builder.field(for: \.id)
            builder.field(for: \.name)
            builder.field(for: \.description, type: .longtext)
            builder.field(for: \.url)
            builder.field(for: \.github)
            builder.field(for: \.imageURL)
            builder.field(for: \.createdAt)
            builder.field(for: \.updatedAt)
        })
    }
    
}
extension Project: Parameter {}

