//
//  ProjectsController.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Vapor

struct ProjectsController: TechController {
    
    
    
    typealias T = Project
    typealias Public = Project.Public
    static var path = "projects"
    
    func boot(router: Router) throws {
        let usersRoute = router.grouped(TechApi.path, ProjectsController.path)
        
        
        let protectedRoutes = usersRoute.grouped(AdminJWTMiddleWareProvider())
        protectedRoutes.post(T.self, use: createHandler)
        protectedRoutes.get(use: getAllHandler)
        protectedRoutes.delete(T.parameter, use: deleteHandler)
        protectedRoutes.get(T.parameter, use: getHandler)
        protectedRoutes.put(T.parameter, use: updateHandler)
    }
    
    func createHandler(_ req: Request, entity: T) throws -> Future<Public> {
        return entity.save(on: req)
    }
    
    func getAllHandler(_ req: Request) throws -> EventLoopFuture<[T.Public]> {
        return T.query(on: req).decode(data: Public.self).all()
    }
    
    func getHandler(_ req: Request) throws -> EventLoopFuture<T.Public> {
        return try req.parameters.next(T.self)
    }
    
    func updateHandler(_ req: Request) throws -> EventLoopFuture<T.Public> {
        return try flatMap(to: T.Public.self,
                           req.parameters.next(T.self),
                           req.content.decode(T.self)) { item, updatedItem in
                            item.description = updatedItem.description
                            item.name = updatedItem.name
                            item.url = updatedItem.url
                            item.github = updatedItem.github
                            item.imageURL = updatedItem.imageURL
                            item.sort = updatedItem.sort
                            item.galleryURL = updatedItem.galleryURL
                            return item.save(on: req)
        }
    }
    
    func deleteHandler(_ req: Request) throws -> EventLoopFuture<HTTPStatus> {
        return try req.parameters.next(T.self).delete(on: req).transform(to: HTTPStatus.noContent)
    }
}
