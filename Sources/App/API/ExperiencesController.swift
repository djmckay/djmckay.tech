//
//  ExperiencesController.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Vapor

struct ExperiencesController: TechController {
    
    
    
    typealias T = Experience
    typealias Public = Experience.Public
    static var path = "experiences"
    
    func boot(router: Router) throws {
        let usersRoute = router.grouped(TechApi.path, ExperiencesController.path)
        
        
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
                            item.summary = updatedItem.summary
                            item.header = updatedItem.header
                            item.title = updatedItem.title
                            item.text = updatedItem.text
                            item.action = updatedItem.action
                            item.current = updatedItem.current
                            item.location = updatedItem.location
                            item.sort = updatedItem.sort
                            return item.save(on: req)
        }
    }
    
    func deleteHandler(_ req: Request) throws -> EventLoopFuture<HTTPStatus> {
        return try req.parameters.next(T.self).delete(on: req).transform(to: HTTPStatus.noContent)
    }
}
