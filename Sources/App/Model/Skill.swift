//
//  Skill.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import FluentMySQL
import Authentication

final class Skill: BaseUserTrackable {
    var createdAt: Date?
    
    var updatedAt: Date?
    
    typealias Public = Skill
    
    
    var id: UUID?
    var image: String?
    var title: String
    var text: String?
    var supportingText: String?
    
    init(image: String?, title: String, text: String?, supportingText: String?) {
        self.image = image
        self.title = title
        self.text = text
        self.supportingText = supportingText
    }
    
    func convertToPublic() -> Skill {
        return self
    }
    
}

extension Skill: Content {}
extension Skill: Migration {}
extension Skill: Parameter {}
