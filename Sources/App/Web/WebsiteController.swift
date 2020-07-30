//
//  WebsiteController.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Vapor
import Leaf
import Fluent
import Authentication
import FluentMySQL
import JWT

struct WebsiteController: RouteCollection {
    func boot(router: Router) throws {
        router.get(use: indexHandler)
        router.post(ContactPostData.self, use: contactPostHandler)
        router.get("resume", use: resumeHandler)
        router.get("status") { (req) -> Future<View> in
            return try req.view().render("status", ["database": Environment.get("DATABASE_DB") ?? "missing", "database_host": Environment.get("DATABASE_HOSTNAME") ?? "missing host", "database_user": Environment.get("DATABASE_USER"), "configs": Environment.get("DATABASE_PASSWORD")])
        }
    }
    
    func contactPostHandler(_ req: Request, userData: ContactPostData) throws -> Future<View> {
    
        let bespin = try req.make(BespinClient.self)
        let form = ["name": userData.name, "phone": userData.phone, "message": userData.message, "email": userData.email]
        var alert = "Are you a spambot?"
        if userData.spam.isEmpty || userData.spam == "4" || userData.spam.lowercased() == "four" {
            alert = "Thanks for sending me a message!"
            let bcc = Environment.get("BESPIN_BCC") ?? Bundle(for: BespinClient.self).infoDictionary?["BESPIN_BCC"] as? String ?? "<email>"
            let from = Environment.get("BESPIN_FROM") ?? Bundle(for: BespinClient.self).infoDictionary?["BESPIN_FROM"] as? String ?? "<email>"
            let variables = [userData.email : form, bcc: form ]
            let template = Environment.get("BESPIN_TEMPLATE") ?? Bundle(for: BespinClient.self).infoDictionary?["BESPIN_TEMPLATE"] as? String ?? "51807F8C-0B7E-4D08-9163-120ED821CAAC"
            let message = Message(from: EmailAddress(email: from), replyTo: nil, cc: nil, bcc: [EmailAddress(email: bcc)], to: [EmailAddress(email: userData.email)], text: nil, html: nil, subject: nil, recipientVariables: variables, template: template)
            _ = try bespin.send(message, on: req)
        }
        return flatMap(Project.query(on: req).sort(\.sort).all(), Site.query(on: req).first(), Social.query(on: req).all()) { (projects, site, socials) -> (EventLoopFuture<View>) in
            
            var socialContexts: [SocialContext] = []
            for social in socials {
                socialContexts.append(SocialContext(url: social.url, handle: social.handle, icon: social.icon))
            }
            var projectContexts: [ProjectContext] = []
            for project in projects {
                projectContexts.append(ProjectContext(name: project.name, description: project.description, url: project.url, github: project.github, imageURL: project.imageURL, galleryURL: project.galleryURL))
            }
            let indexContext: IndexContext = IndexContext(brand: site?.brand ?? "missing brand", socials: socialContexts, title: site?.title ?? "missing title", portfolio: PortfolioContext(projects: projectContexts), header: site?.header ?? "missing header", about: site?.about ?? "missing about", alert: alert, avatar: site?.avatar, avatarByLine: site?.avatarByLine)
            return try req.view().render("index", indexContext)
            
            
        }
    }
    
    func indexHandler(_ req: Request) throws -> Future<View> {
        
        return flatMap(Project.query(on: req).sort(\.sort).all(), Site.query(on: req).first(), Social.query(on: req).all()) { (projects, site, socials) -> (EventLoopFuture<View>) in
            
            var socialContexts: [SocialContext] = []
            for social in socials {
                socialContexts.append(SocialContext(url: social.url, handle: social.handle, icon: social.icon))
            }
            var projectContexts: [ProjectContext] = []
            for project in projects {
                projectContexts.append(ProjectContext(name: project.name, description: project.description, url: project.url, github: project.github, imageURL: project.imageURL, galleryURL: project.galleryURL))
            }
            let indexContext: IndexContext = IndexContext(brand: site?.brand ?? "missing brand", socials: socialContexts, title: site?.title ?? "missing title", portfolio: PortfolioContext(projects: projectContexts), header: site?.header ?? "missing header", about: site?.about ?? "missing about", alert: nil, avatar: site?.avatar, avatarByLine: site?.avatarByLine)
            return try req.view().render("index", indexContext)

            
        }
        
        
    }
    
    func resumeHandler(_ req: Request) throws -> Future<View> {
        return try! ResumePage.render(req)
        
    }
}


protocol BaseContext: Encodable {
    var brand: String { get set }
    var socials: [SocialContext] { get set }
    var title: String { get set }
}

struct IndexContext: BaseContext {
    var brand: String
    var socials: [SocialContext]
    var title: String
    var portfolio: PortfolioContext
    var header: String
    var about: String
    var alert: String?
    var avatar: String?
    var avatarByLine: String?
}

struct PortfolioContext: Encodable {
    var projects: [ProjectContext]
}


struct ProjectContext: Encodable {
    var name: String
    var description: String
    var url: String?
    var github: String?
    var imageURL: String?
    var galleryURL: String?
}

struct SocialContext: Encodable {
    var url: String?
    var handle: String?
    var icon: String?
}

struct ContactPostData: Content {
    let name: String
    let email: String
    let phone: String
    let message: String
    let spam: String
}


