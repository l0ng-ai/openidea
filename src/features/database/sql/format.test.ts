import { describe, expect, it } from "vitest";
import { formatSql, formatted } from "./format";

const fmt = (sql: string) => {
  let out = sql;
  for (const e of formatSql(sql, "sqlite").reverse()) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
};

describe("formatSql", () => {
  it("lays out a query like IDEA", () => {
    expect(
      fmt(
        "SELECT u.id,u.name , count( * ) AS n FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.id>1 AND o.total BETWEEN 1 AND 5 OR o.status='x' GROUP BY u.id ORDER BY n DESC LIMIT 10;",
      ),
    ).toBe(
      [
        "SELECT u.id,",
        "       u.name,",
        "       count(*) AS n",
        "FROM users u",
        "         LEFT JOIN orders o ON o.user_id = u.id",
        "WHERE u.id > 1",
        "  AND o.total BETWEEN 1 AND 5",
        "   OR o.status = 'x'",
        "GROUP BY u.id",
        "ORDER BY n DESC",
        "LIMIT 10;",
      ].join("\n"),
    );
  });

  it("aligns subqueries and CTEs after their parenthesis", () => {
    expect(
      fmt(
        "with big as (select user_id, total from orders where total > 10) select * from big where exists (select 1 from users u where u.id = big.user_id);",
      ),
    ).toBe(
      [
        "with big as (select user_id,",
        "                    total",
        "             from orders",
        "             where total > 10)",
        "select *",
        "from big",
        "where exists (select 1",
        "              from users u",
        "              where u.id = big.user_id);",
      ].join("\n"),
    );
  });

  it("formats DML and DDL", () => {
    expect(fmt("insert into users(email,name) values('a', -1),('b',cast(2 as text));")).toBe(
      "insert into users (email, name)\nvalues ('a', -1),\n       ('b', cast(2 as text));",
    );
    expect(fmt("update users set name='x', email = 'y' where id=1;")).toBe(
      "update users\nset name = 'x',\n    email = 'y'\nwhere id = 1;",
    );
    expect(fmt("delete from orders where id = 1;")).toBe("delete\nfrom orders\nwhere id = 1;");
    expect(fmt("create table t (id integer primary key, name varchar(10) not null);")).toBe(
      "create table t\n(\n    id integer primary key,\n    name varchar(10) not null\n);",
    );
    expect(fmt("select 1 union all select 2;")).toBe("select 1\nunion all\nselect 2;");
  });

  it("keeps comments, text between statements and the range", () => {
    const sql = "-- head\nselect a -- why\n, b from t;\n\n\nselect   1;";
    expect(fmt(sql)).toBe("-- head\nselect a, -- why\n       b\nfrom t;\n\n\nselect 1;");
    const edits = formatSql(sql, "sqlite", { from: sql.length - 2, to: sql.length - 1 });
    expect(edits).toEqual([{ from: sql.lastIndexOf("select"), to: sql.length, insert: "select 1;" }]);
  });

  it("keeps Snowflake dollar strings, comments, casts, variant paths and stages", () => {
    const sf = (sql: string) => formatted(sql, "snowflake");
    expect(sf("select src:customer.name::string,src['k'].v[0] from t where x=$$ a  b $$ // why\n;")).toBe(
      "select src:customer.name::string,\n       src['k'].v[0]\nfrom t\nwhere x = $$ a  b $$ // why\n;",
    );
    expect(sf("select $1 from @my_stage/path/f.csv (file_format=>'ff') t where y='it\\'s; ok';")).toBe(
      "select $1\nfrom @my_stage/path/f.csv (file_format => 'ff') t\nwhere y = 'it\\'s; ok';",
    );
    expect(sf("select a from t qualify row_number() over (order by a)=1 and a>0;")).toBe(
      "select a\nfrom t\nqualify row_number() over(order by a) = 1\n  and a > 0;",
    );
    expect(sf("show tables ->> select $1 from $1;")).toBe("show tables ->>\nselect $1\nfrom $1;");
    const body = "create procedure p() returns int language sql as $$ begin  return 1; end $$;";
    expect(sf(body)).toContain("$$ begin  return 1; end $$;");
  });
});
