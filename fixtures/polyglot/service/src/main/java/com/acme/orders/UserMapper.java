package com.acme.orders;

import java.util.List;

import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/**
 * MyBatis mapper for the QA of the mapper gutter and the generate actions.
 *
 * `findById` is bound twice in the XML (`databaseId` variants), so its icon opens
 * the chooser. `countAll` carries its SQL in an annotation and so has no statement
 * to generate. `selectByName` and `insertUser` have none and two parameters each,
 * which is what the context actions offer.
 */
public interface UserMapper {
    User findById(@Param("id") Long id);

    List<User> selectByName(String name, String dept);

    @Select("SELECT COUNT(*) FROM t_user")
    int countAll();

    int insertUser(String name, String dept);
}
