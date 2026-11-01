package com.example.mapper;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.example.entity.User;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UserMapper {

    User selectById(Long id);

    List<User> selectByStatus(@Param("status") Integer status, @Param("keyword") String keyword);

    @Select("SELECT * FROM user WHERE email = #{email}")
    Optional<User> findByEmail(String email);

    int updateName(@Param("userId") Long userId, @Param("newName") String newName);
    int updateName(@Param("userId") Long userId, @Param("newName") String newName,@Param("password") String password);

    void insertUser(User user);
    void insertUser(@Param("user1") User user1,@Param("user2") User user2);

    void deleteById(Long id);

    long count();

    Map<String, User> allUsers();
}
