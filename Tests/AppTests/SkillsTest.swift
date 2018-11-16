//
//  SkillsTest.swift
//  AppTests
//
//  Created by DJ McKay on 11/15/18.
//

@testable import App
import Vapor
import XCTest
import FluentMySQL
import JWT
import Crypto

class SkillsTests: XCTestCase {
    
    var uri: String = "/api/skills/"
    var app: Application!
    var conn: MySQLConnection!
    var headers: HTTPHeaders!
    var social: Social!
    
    override func setUp() {
        // Put setup code here. This method is called before the invocation of each test method in the class.
        try! Application.reset()
        app = try! Application.testable()
        conn = try! app.newConnection(to: .DJMcKayTech).wait()
        headers = HTTPHeaders()
        // create payload
        let adminToken = AdminToken(key: "1234567890987654321")
        
        // create JWT and sign
        let jwt = try! JWT(payload: adminToken).sign(using: .hs256(key: "secret"))
        headers = HTTPHeaders()
        headers.add(name: .authorization, value: "Bearer \(String(data: jwt, encoding: .utf8) ?? "")")
        headers.add(name: "Content-Type", value: "application/json")
        
    }
    
    func testSkillCanBeRetrievedFromAPI() throws {
        // This is an example of a functional test case.
        // Use XCTAssert and related functions to verify your tests produce the correct results.
        
        var skill = try Skill(image: nil, title: "skill 1", text: "some text", supportingText: nil).save(on: conn).wait()
        
        
        let skills = try app.getResponse(to: uri, headers: headers, decodeTo: [Skill].self)
        
        XCTAssertEqual(skills.count, 1)
        XCTAssertEqual(skills[0].image, skill.image)
        XCTAssertEqual(skills[0].id, skill.id)
        XCTAssertEqual(skills[0].title, skill.title)
        XCTAssertEqual(skills[0].text, skill.text)
        XCTAssertEqual(skills[0].supportingText, skill.supportingText)
    }
    
    func testSkillCanBeSavedWithAPI() throws {
        let skill = Skill(image: nil, title: "skill 1", text: "some text", supportingText: nil)
        
        let foundItem = try app.getResponse(to: uri, method: .POST, headers: headers, data: skill, decodeTo: Skill.self)
        
        XCTAssertEqual(foundItem.image, skill.image)
        XCTAssertEqual(foundItem.text, skill.text)
        XCTAssertEqual(foundItem.title, skill.title)
        XCTAssertEqual(foundItem.supportingText, skill.supportingText)

        XCTAssertNotNil(foundItem.id)
        
        let skills = try app.getResponse(to: uri, headers: headers, decodeTo: [Skill].self)
        
        XCTAssertEqual(skills.count, 1)
        XCTAssertEqual(skills[0].image, foundItem.image)
        XCTAssertEqual(skills[0].id, foundItem.id)
        XCTAssertEqual(skills[0].text, foundItem.text)
        XCTAssertEqual(skills[0].title, foundItem.title)
        XCTAssertEqual(skills[0].supportingText, foundItem.supportingText)
    }
    
    func testSkillCanBeUpdateWithAPI() throws {
        var skill = try Skill(image: nil, title: "skill 1", text: "some text", supportingText: nil).save(on: conn).wait()

        skill.image = "imagem"
        skill.title = "skill 2"
        skill.text = "new text"
        skill.supportingText = "supporting text"
        
        let foundItem = try app.getResponse(to: "\(uri)\(skill.id!)", method: .PUT, headers: headers, data: skill, decodeTo: Skill.self)
        
        XCTAssertEqual(foundItem.image, skill.image)
        XCTAssertEqual(foundItem.title, skill.title)
        XCTAssertEqual(foundItem.text, skill.text)
        XCTAssertEqual(foundItem.supportingText, skill.supportingText)
        XCTAssertNotNil(foundItem.id)
        
        let skills = try app.getResponse(to: uri, headers: headers, decodeTo: [Skill].self)
        
        XCTAssertEqual(skills.count, 1)
        XCTAssertEqual(skills[0].image, foundItem.image)
        XCTAssertEqual(skills[0].id, foundItem.id)
        XCTAssertEqual(skills[0].text, foundItem.text)
        XCTAssertEqual(skills[0].title, foundItem.title)
        XCTAssertEqual(skills[0].supportingText, foundItem.supportingText)
    }
    
    func testSkillCanBeDeletedWithAPI() throws {
        var skill = try Skill(image: nil, title: "skill 1", text: "some text", supportingText: nil).save(on: conn).wait()

        var skills = try app.getResponse(to: uri, headers: headers, decodeTo: [Skill].self)
        
        XCTAssertEqual(skills.count, 1)
        
        _ = try app.sendRequest(to: "\(uri)\(skill.id!)", method: .DELETE, headers: headers)
        
        skills = try app.getResponse(to: uri, headers: headers, decodeTo: [Skill].self)
        
        XCTAssertEqual(skills.count, 0)
        
    }
    
}

