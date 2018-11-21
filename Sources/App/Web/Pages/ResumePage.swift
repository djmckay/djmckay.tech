//
//  ResumePage.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import Leaf

struct ResumePage {
        static func render(_ req: Request) throws -> Future<View> {
//            return flatMap(Profile.query(on: req).first(), Experience.query(on: req).all(), Education.query(on: req).all(), Skill.query(on: req).all(), Social.query(on: req).all()) { (profile, experiences, educations, skills, socials) -> (EventLoopFuture<View>) in
//                let profileContext = ProfileContext(name: profile?.name ?? "", summary: profile?.summary ?? "", action: profile?.action ?? "", contact: ContactContext(phone: profile?.phone ?? "", email: profile?.email ?? "", address: profile?.address ?? ""))
//                
//            }
            var profileContext = ProfileContext(name: "David Leon McKay Jr", summary: "Over 18 years of application development on wide range of platforms from mainframe, Java EE, web and mobile platforms. Interested in leveraging different and new emerging technologies to provide customer centric solutions. Currently doing freelance work for iOS applications with or without backend web services including related web applications.", action: "", contact: ContactContext(phone: "816-294-1681", email: "djmckay@me.com", address: "511 Deer Run Way, Woodstock GA 30189"))
            
            
            let current = ExperienceContext(header: "IAM WIRELESS", title: "SELF EMPLOYED", summary: "", text: "Consulting services for telecom/wireless industry. Design and develop web based applications for a training/forum user group. Develop the event management system, registration/training enrollment, invoice and payment processes. Developed using apache, HTML, CSS, mySQL, javascript, jquery and PHP. Replaced Filemaker application with custom iOS application to allow administration of the event, create and process invoices. Developed web payment module interfacing with Paypal.</br></br>  Developed iOS application to allow attendees to register and check-in via iPad kiosks. </br></br>Develop iOS application for exhibitor lead retrieval management system.  </br></br>Currently migrating backend application to vapor cloud and server side swift.", action: " MAR 2017-PRESENT", current: true, location: "WOODSTOCK, GA")
            
            let accentureLast = ExperienceContext(header: "ACCENTURE", title: "SOFTWARE ENGINEERING MANAGER", summary: "", text: "Lead Test Automation role. Develop automated test for SOA based application. Write java based framework to test XML services and web based UI components using Selenium, Cucumber, Spring and Junit. When appropriate, provide test tools to assist in manual testing. Run and report tests using Jenkins automation as part of CICD.<br><br>Java, Spring, Cucumber, Junit, Selenium, Jenkins, XML, Tibco and MQ, SQL, Hibernate, Java Swing", action: "JAN 2016-MAR 2017", current: false, location: "WASHINGTON, D.C.")
            
            let accenture = ExperienceContext(header: "ACCENTURE", title: "SOFTWARE ENGINEERING MANAGER", summary: "", text: "Sr java developer role supporting a custom java SOA implementation of a large web- based transactional system for a major financial services client. Work directly with the client to create solution and design specifications, develop application code, and support application deployment. Skilled with Java development and the Spring MVC Framework, RESTFul Web services, Hibernate, SQL, Relational Databases, Gemfire Cache, Unix, and application server configurations.", action: " AUG 2014- JAN 2016", current: false, location: "ATLANTA, GA")
            
            let travelport = ExperienceContext(header: "TRAVELPORT", title: "LEAD SOFTWARE ENGINEER", summary: "", text: "Design, develop, test XML web service application for managing an airlines ancillary fees related to travel. Serve as an application lead utilizing Java EE on IBM Websphere Application Server and Operational Decision Manager (ilog rules engine). This role worked closely with the product and business analyst teams to refine requirements into a deliverable solution. Also served as subject matter expert related to airline functionality for many team members.<br><br>Design, develop, and test software on a TPF platform for a global Computer Reservation System. Responsibilities include role as technical lead programmer writing Technical Design Documents. Working with Quality Assurance group to ensure speed to market and quality to market products. Work with external and internal customers to gather requirements for products during Functional Design process, beta testing and during post implementation providing customer support.", action: "1999-2014", current: false, location: "KANSAS CITY, MO")
            var exprienceContexts = [current, accentureLast, accenture, travelport]

            var educationContexts = [EducationContext(title: "Missouri Western State University", summary: nil, text: "Bachelor's degree, Mathematics and Computer Science · 1999", supportingText: "Saint Joseph, MO")]
            
            var skillContexts: [SkillContext] = []
            
            return flatMap(Skill.query(on: req).sort(\.title).all(), Experience.query(on: req).sort(\.sort).all(), Social.query(on: req).all(), Profile.query(on: req).first(), Education.query(on: req).sort(\.sort).all()) { (skills, experiences, socials, profile, educations) -> (EventLoopFuture<View>) in
                for skill in skills {
                    skillContexts.append(SkillContext(image: skill.image, title: skill.title, text: skill.text, supportingText: skill.supportingText))
                }
                for experience in experiences {
                    exprienceContexts.append(ExperienceContext(header: experience.header, title: experience.title, summary: experience.summary, text: experience.text, action: experience.action, current: experience.current, location: experience.location))
                }
                var socialContexts: [SocialContext] = []
                for social in socials {
                    socialContexts.append(SocialContext(url: social.url, handle: social.handle, icon: social.icon))
                }
                if let profile = profile {
                    profileContext = ProfileContext(name: profile.name, summary: profile.summary, action: profile.action, contact: ContactContext(phone: profile.phone, email: profile.email, address: profile.address))
                }
                for education in educations {
                    educationContexts.append(EducationContext(title: education.title, summary: education.summary, text: education.text, supportingText: education.supportingText))
                }
                return Site.query(on: req).first().flatMap({ (site) -> EventLoopFuture<View> in
                    let context = ResumeContext(brand: site?.brand ?? "Missing brand", socials: socialContexts, title: "Resume", profile: profileContext, experiences: exprienceContexts, educations: educationContexts, skills: skillContexts, url: profile?.downloadURL)
                    return try! req.make(ViewRenderer.self).render("resume", context)
                })
                
                
            }
            
            
    }
}

struct ResumeContext: BaseContext {
    var brand: String
    var socials: [SocialContext]
    var title: String
    var profile: ProfileContext
    var experiences: [ExperienceContext]
    var educations: [EducationContext]
    var skills: [SkillContext]
    var url: String?
}

struct ProfileContext: Encodable {
    var name: String
    var summary: String
    var action: String
    var contact: ContactContext
}

struct ContactContext: Encodable {
    var phone: String
    var email: String
    var address: String
}

struct ExperienceContext: Encodable {
    var header: String
    var title: String
    var summary: String
    var text: String
    var action: String
    var current: Bool
    var location: String
}

struct EducationContext: Encodable {
    var title: String
    var summary: String?
    var text: String
    var supportingText: String
}

struct SkillContext: Encodable {
    var image: String?
    var title: String?
    var text: String?
    var supportingText: String?
}
